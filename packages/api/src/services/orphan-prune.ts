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
  /** Column holding the key that ties this row to its parent row. */
  idColumn: string;
  /**
   * The parent table + column `idColumn` references. Defaults to
   * `library_songs.id`.
   *
   * The shape used to be `references: 'id' | 'path'` — a `library_songs` column
   * name — which quietly made "song-keyed" the only expressible relationship.
   * Album- and artist-keyed side tables therefore had no sweep at all, and on
   * prod carried 1,259 orphan rows (issue #965). The scan cache keys on `path`
   * because it answers "have I already parsed this file?" before any id exists.
   */
  parent?: { table: string; column: string };
  /** Extra predicate restricting which rows of `table` this entry owns. */
  where?: string;
  /**
   * Count orphans but never delete them — for tables holding human-authored
   * data, the same reason `library_lyrics` is absent entirely.
   */
  measureOnly?: boolean;
}

const SONGS_PARENT = { table: 'library_songs', column: 'id' } as const;
const ARTIST_ALBUMS_PARENT = { table: 'library_albums', column: 'id' } as const;

/** `NOT IN (SELECT …)` fragment locating this entry's orphans. */
function orphanPredicate(t: OrphanTable): string {
  const p = t.parent ?? SONGS_PARENT;
  const base = `${t.idColumn} NOT IN (SELECT ${p.column} FROM ${p.table})`;
  return t.where ? `(${base}) AND (${t.where})` : base;
}

/** The inverse — rows whose parent is present again. */
function presentPredicate(t: OrphanTable): string {
  const p = t.parent ?? SONGS_PARENT;
  const base = `${t.idColumn} IN (SELECT ${p.column} FROM ${p.table})`;
  return t.where ? `(${base}) AND (${t.where})` : base;
}

/** Rows this entry owns at all (its denominator for the sanity ratio). */
function scopePredicate(t: OrphanTable): string {
  return t.where ?? '1=1';
}

/**
 * Regenerable per-song artifacts, plus `acquisitions` by explicit product
 * decision (#319). For the first three, adding a table here is a statement that
 * losing its rows costs compute, not human or network-sourced data.
 * `acquisitions` is the exception: it is *history*, not regenerable — but it is
 * unreachable once its file is gone (provenance is surfaced only per-track), the
 * operator chose to prune it, and the 30-day grace + prior repoint make the
 * deletion safe. Curator tables (genres/artists/overrides/lyrics) stay out.
 */
export const ORPHAN_TABLES: OrphanTable[] = [
  // ~46% of the whole prod database is embedding blobs; this is the one that
  // carries real bytes, and the sidecar can recompute it for free.
  { table: 'library_embeddings', idColumn: 'song_id' },
  // Timbre/groove/band descriptors from the same sidecar — ~2 KB of JSON per
  // song, recomputed in ~5 s. Regenerable, so it belongs with the embeddings.
  { table: 'library_song_descriptors', idColumn: 'song_id' },
  // A pure ledger of analysis attempts — meaningless without its song.
  { table: 'library_song_analysis_failures', idColumn: 'song_id' },
  // Raw tag JSON keyed on path+size+mtime, purely to skip re-parsing an
  // unchanged file. An entry whose path is gone can never be hit again — the
  // lookup is by path — so this is the one table where an orphan is provably
  // unreachable rather than merely unused (issue #313). Prod: 2,969 orphans of
  // 17,549 (17 %, 1.16 MB of tag JSON). The only existing DELETE is a full wipe
  // on a schema-version bump, so orphans otherwise accumulate until that fires.
  { table: 'scan_cache', idColumn: 'path', parent: { table: 'library_songs', column: 'path' } },
  // Download provenance (method/source/time) keyed on the song's path. When the
  // file is gone the row is unreachable — provenance is surfaced *per track* and
  // there is no track. Prod: 4,586 orphans of 15,470 (30 %). Pruning is a product
  // call the operator made in #319; it is safe because the daily pass runs
  // `repointOrphanedAcquisitions` first, which recovers the ~17 orphans that are
  // the only surviving provenance for a still-live song (its file merely changed
  // extension) — so only genuinely-deleted rows ever reach the sweep. Path-keyed
  // like `scan_cache`, so an orphan here is likewise provably unreachable.
  {
    table: 'acquisitions',
    idColumn: 'relative_path',
    parent: { table: 'library_songs', column: 'path' },
  },

  // --- Album- and artist-keyed side tables (issue #965) -------------------
  //
  // These had no sweep at all, and the cost is not disk: album and artist ids
  // are **name-derived**, not surrogate, so an orphan row is a live landmine.
  // Rename an album, its `library_artwork` row is orphaned and stays; if that
  // exact artist+title ever exists again — a re-download, a rename back, a
  // correction landing on the old spelling — the new album mints the SAME id
  // and silently inherits the old cover. No error, no log line. One curation
  // pass renamed ~50 albums and merged ~45 artists, each re-minting ids.
  //
  // `library_release_meta` is worse in kind: it is authoritative over
  // classification, so a resurrected id inherits a stale `album_type` and
  // `canonical_title` from a different release.
  {
    table: 'library_artwork',
    idColumn: 'id',
    parent: { table: 'library_albums', column: 'id' },
    where: "kind = 'album'",
  },
  {
    table: 'library_artwork',
    idColumn: 'id',
    parent: { table: 'library_artists', column: 'id' },
    where: "kind = 'artist'",
  },
  { table: 'library_release_meta', idColumn: 'album_id', parent: ARTIST_ALBUMS_PARENT },
  {
    table: 'library_artist_origins',
    idColumn: 'artist_id',
    parent: { table: 'library_artists', column: 'id' },
  },
  // Measure-only: holds user-editable bios behind `manual_override`, i.e. the
  // curator data the no-cascade design exists to protect. Same standing as
  // `library_lyrics`, which is left out of the table entirely — but this one is
  // worth *counting*, because 217 of 3,740 rows being unreachable is a signal
  // about renames even when nothing should be deleted.
  {
    table: 'library_artist_meta',
    idColumn: 'artist_id',
    parent: { table: 'library_artists', column: 'id' },
    measureOnly: true,
  },
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
    const { table } = entry;
    try {
      const rows = Number(
        (
          db
            .query<{ c: number }, []>(
              `SELECT COUNT(*) c FROM ${table} WHERE ${scopePredicate(entry)}`,
            )
            .get() ?? { c: 0 }
        ).c,
      );
      const orphans = Number(
        (
          db
            .query<{ c: number }, []>(
              `SELECT COUNT(*) c FROM ${table} WHERE ${orphanPredicate(entry)}`,
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
  // reason to delete every cached embedding we have. `library_songs` stands in
  // for every parent: the scanner rebuilds albums and artists from songs, so a
  // library with songs has the other two.
  if (songCount === 0) return result;

  for (const entry of ORPHAN_TABLES) {
    const { table } = entry;
    if (entry.measureOnly) continue;
    try {
      const rows = Number(
        (
          db
            .query<{ c: number }, []>(
              `SELECT COUNT(*) c FROM ${table} WHERE ${scopePredicate(entry)}`,
            )
            .get() ?? { c: 0 }
        ).c,
      );
      if (rows === 0) continue;

      const orphans = Number(
        (
          db
            .query<{ c: number }, []>(
              `SELECT COUNT(*) c FROM ${table} WHERE ${orphanPredicate(entry)}`,
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
             WHERE orphaned_at IS NULL AND ${orphanPredicate(entry)}`,
            [now],
          ).changes ?? 0,
        );
        // The song came back (re-download mints the same deterministic id).
        result.unmarked += Number(
          db.run(
            `UPDATE ${table} SET orphaned_at = NULL
             WHERE orphaned_at IS NOT NULL AND ${presentPredicate(entry)}`,
          ).changes ?? 0,
        );
        result.deleted += Number(
          db.run(
            `DELETE FROM ${table}
             WHERE orphaned_at IS NOT NULL AND orphaned_at < ? AND ${scopePredicate(entry)}`,
            [now - graceMs],
          ).changes ?? 0,
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
