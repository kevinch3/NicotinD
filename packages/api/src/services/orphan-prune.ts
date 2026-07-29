import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';
import { repointOrphanedAcquisitions } from './acquisition-repoint.js';

const log = createLogger('orphan-prune');

/**
 * Bound the growth of per-song side tables whose owning song is gone.
 *
 * The per-song side tables deliberately have **no FK cascade** to
 * `library_songs`: the scanner rebuilds that table wholesale on every rescan,
 * so a cascade would wipe curator data (lyrics, genre sets, overrides) on every
 * scan. That design is right and stays — see docs/cache-invalidation.md. Its
 * only cost is that deleting a song leaves its side rows behind forever.
 *
 * **Measured on prod before building any of this** (issue #259), and the
 * numbers changed the shape of the fix:
 *
 * | table                            |   rows | orphans |
 * | -------------------------------- | -----: | ------: |
 * | `library_embeddings`             | 15,456 |   1,057 |  5.16 MB
 * | `library_song_analysis_failures` | 19,399 |     233 |
 * | `library_lyrics`                 |    839 |      35 |
 * | `library_song_genres`            | 31,623 |       0 |
 * | `library_song_artists`           | 15,198 |       0 |
 * | `library_genre_overrides` (song) |    311 |       0 |
 *
 * The tables the no-cascade design exists to protect — genres, artists,
 * overrides — carry **zero** orphans, because the scanner rebuilds them rather
 * than accumulating. The tables that actually grow are the *regenerable* ones.
 * So there is no retention tension to trade off here: we prune only rows that
 * cost compute to rebuild, never curation.
 *
 * `library_lyrics` is deliberately **not** pruned despite having orphans: a
 * lyrics document is network-sourced and user-editable — exactly the curator
 * data the no-cascade design protects — and 35 rows is not worth trading that
 * for.
 */
export interface OrphanTable {
  table: string;
  /** Column holding the key that ties this row to its owning song. */
  songIdColumn: string;
  /**
   * Which `library_songs` column `songIdColumn` references. Most side tables
   * key on the deterministic song `id`; the scan cache keys on `path` because
   * it exists to answer "have I already parsed this file?" before any id has
   * been minted. Defaults to `id`.
   */
  references?: 'id' | 'path';
}

/** The `library_songs` column an orphan check compares against. */
function referencedColumn(t: OrphanTable): string {
  return t.references ?? 'id';
}

/**
 * Only regenerable per-song artifacts. Adding a table here is a statement that
 * losing its rows costs compute, not human or network-sourced data.
 */
export const ORPHAN_TABLES: OrphanTable[] = [
  // ~46% of the whole prod database is embedding blobs; this is the one that
  // carries real bytes, and the sidecar can recompute it for free.
  { table: 'library_embeddings', songIdColumn: 'song_id' },
  // A pure ledger of analysis attempts — meaningless without its song.
  { table: 'library_song_analysis_failures', songIdColumn: 'song_id' },
  // Raw tag JSON keyed on path+size+mtime, purely to skip re-parsing an
  // unchanged file. An entry whose path is gone can never be hit again — the
  // lookup is by path — so this is the one table where an orphan is provably
  // unreachable rather than merely unused (issue #313). Prod: 2,969 orphans of
  // 17,549 (17 %, 1.16 MB of tag JSON). The only existing DELETE is a full wipe
  // on a schema-version bump, so orphans otherwise accumulate until that fires.
  { table: 'scan_cache', songIdColumn: 'path', references: 'path' },
];

/** Default grace period: an orphan must persist this long before deletion. */
export const DEFAULT_ORPHAN_GRACE_MS = 30 * 24 * 3_600_000;

/**
 * Refuse to mark when this share of a table looks orphaned. A healthy library
 * churns a few percent; a number this high means `library_songs` is mid-rebuild
 * or was truncated, and marking would stage the entire table for deletion.
 *
 * The scanner upserts inside a transaction and prunes by stale `synced_at`, so
 * it never transiently empties `library_songs` today — this is insurance
 * against that ever changing, not a known failure.
 */
const SANITY_MAX_ORPHAN_RATIO = 0.5;

export interface OrphanCount {
  table: string;
  rows: number;
  orphans: number;
}

/** Per-table orphan counts, for admin reporting. Missing tables are skipped. */
export function countOrphanRows(db: Database): OrphanCount[] {
  const out: OrphanCount[] = [];
  for (const entry of ORPHAN_TABLES) {
    const { table, songIdColumn } = entry;
    const ref = referencedColumn(entry);
    try {
      const rows = Number(
        (db.query<{ c: number }, []>(`SELECT COUNT(*) c FROM ${table}`).get() ?? { c: 0 }).c,
      );
      const orphans = Number(
        (
          db
            .query<{ c: number }, []>(
              `SELECT COUNT(*) c FROM ${table}
               WHERE ${songIdColumn} NOT IN (SELECT ${ref} FROM library_songs)`,
            )
            .get() ?? { c: 0 }
        ).c,
      );
      out.push({ table, rows, orphans });
    } catch {
      // Missing table (minimal test DB) — nothing to report.
    }
  }
  return out;
}

export interface OrphanPruneResult {
  marked: number;
  unmarked: number;
  deleted: number;
}

/**
 * One mark-then-sweep pass.
 *
 * **Mark**: stamp `orphaned_at` on rows whose song is gone and that aren't
 * already stamped. **Unmark**: clear the stamp on any row whose song came back
 * — this is what preserves the delete-then-re-download restore property (song
 * ids are deterministic, so re-downloading the same file reuses the id and the
 * cached embedding survives). **Sweep**: delete only rows that have been
 * orphaned for longer than `graceMs`.
 *
 * A grace period needs to know when a row was orphaned, which is why this is
 * two-phase rather than a single `DELETE … WHERE NOT IN`. `updated_at` can't
 * stand in for it: an embedding computed 60 days ago and orphaned today would
 * be swept immediately, destroying exactly the restore property above.
 *
 * Idempotent and cheap enough for a daily tick.
 */
export function pruneOrphanRows(
  db: Database,
  opts: { graceMs?: number; now?: number } = {},
): OrphanPruneResult {
  const graceMs = opts.graceMs ?? DEFAULT_ORPHAN_GRACE_MS;
  const now = opts.now ?? Date.now();
  const result: OrphanPruneResult = { marked: 0, unmarked: 0, deleted: 0 };

  let songCount = 0;
  try {
    songCount = Number(
      (db.query<{ c: number }, []>('SELECT COUNT(*) c FROM library_songs').get() ?? { c: 0 }).c,
    );
  } catch {
    return result; // schema-less DB (minimal test harness) — nothing to do.
  }
  // An empty library is either a fresh install or a broken one; neither is a
  // reason to delete every cached embedding we have.
  if (songCount === 0) return result;

  for (const entry of ORPHAN_TABLES) {
    const { table, songIdColumn } = entry;
    const ref = referencedColumn(entry);
    try {
      const rows = Number(
        (db.query<{ c: number }, []>(`SELECT COUNT(*) c FROM ${table}`).get() ?? { c: 0 }).c,
      );
      if (rows === 0) continue;

      const orphans = Number(
        (
          db
            .query<{ c: number }, []>(
              `SELECT COUNT(*) c FROM ${table}
               WHERE ${songIdColumn} NOT IN (SELECT ${ref} FROM library_songs)`,
            )
            .get() ?? { c: 0 }
        ).c,
      );
      if (orphans / rows > SANITY_MAX_ORPHAN_RATIO) {
        log.warn(
          { table, rows, orphans },
          'orphan ratio implausibly high — skipping (library may be mid-rebuild)',
        );
        continue;
      }

      const tx = db.transaction(() => {
        result.marked += Number(
          db.run(
            `UPDATE ${table} SET orphaned_at = ?
             WHERE orphaned_at IS NULL
               AND ${songIdColumn} NOT IN (SELECT ${ref} FROM library_songs)`,
            [now],
          ).changes ?? 0,
        );
        // The song came back (re-download mints the same deterministic id).
        result.unmarked += Number(
          db.run(
            `UPDATE ${table} SET orphaned_at = NULL
             WHERE orphaned_at IS NOT NULL
               AND ${songIdColumn} IN (SELECT ${ref} FROM library_songs)`,
          ).changes ?? 0,
        );
        result.deleted += Number(
          db.run(`DELETE FROM ${table} WHERE orphaned_at IS NOT NULL AND orphaned_at < ?`, [
            now - graceMs,
          ]).changes ?? 0,
        );
      });
      tx();
    } catch {
      // Missing table (minimal test DB) — skip, never break the caller's tick.
    }
  }

  if (result.deleted > 0 || result.marked > 0) {
    log.info(result, 'orphan side-table prune');
  }
  return result;
}

const DAY_MARKER = 'orphan_prune_last_day';

function readMarker(db: Database, key: string): string | null {
  const row = db
    .query<{ value: string }, [string]>('SELECT value FROM library_sync_state WHERE key = ?')
    .get(key);
  return row?.value ?? null;
}

function writeMarker(db: Database, key: string, value: string, now: number): void {
  db.run(
    `INSERT INTO library_sync_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, now],
  );
}

/**
 * Daily guard, safe to call every processor tick — the same marker-guarded
 * shape as `maybeRunDailyBackup`. Runs at most one pass per calendar day.
 * Returns true when a pass ran.
 */
export function maybeRunDailyOrphanPrune(
  db: Database,
  opts: { graceMs?: number; now?: number; enabled?: boolean } = {},
): boolean {
  const enabled = opts.enabled ?? process.env.NICOTIND_ORPHAN_PRUNE?.trim().toLowerCase() !== 'off';
  if (!enabled) return false;
  const now = opts.now ?? Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  if (readMarker(db, DAY_MARKER) === day) return false;
  try {
    // Recover provenance whose file merely changed extension before pruning
    // anything (issue #313). Cheap, idempotent, and a prerequisite for ever
    // sweeping `acquisitions` — see acquisition-repoint.ts.
    repointOrphanedAcquisitions(db);
    pruneOrphanRows(db, { graceMs: opts.graceMs, now });
    writeMarker(db, DAY_MARKER, day, now);
    return true;
  } catch (err) {
    // Never let housekeeping break the processing tick; retried next tick.
    log.error({ err }, 'daily orphan prune failed');
    return false;
  }
}
