import type { Database } from 'bun:sqlite';
import { readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Sweep cover-cache files whose owning album/artist/song no longer exists
 * (issue #311).
 *
 * why: `<dataDir>/cover-cache` grows without bound. The only existing removal is
 * `artwork-store.ts`'s targeted purge when one album's canonical URL changes —
 * there is no size or age eviction, unlike the transcode cache. Measured on
 * prod: **3.6 GB total, of which 1.6 GB (28 % of the entity-keyed files) belongs
 * to rows that are gone.**
 *
 * ## Only entity-keyed files are touched
 *
 * Cache keys come in two shapes, and conflating them is the trap:
 *
 * - `<sha1>` / `<sha1>@<size>` — keyed on an album, artist or song id, so
 *   "does the row still exist?" is answerable.
 * - `c_<hash>` / `r_<hash>` — **content-addressed** (the source image or remote
 *   URL). There is no owning row to look up, so they can never be judged this
 *   way and are skipped entirely.
 *
 * A first measurement that missed this reported 51 % / 2.3 GB orphaned by
 * counting all 9,455 content-addressed files as orphans. Deleting on that basis
 * would have thrown away live entries.
 *
 * ## Grace period, for the same reason as issue #259
 *
 * Ids are deterministic, so deleting a song and re-downloading the same file
 * reuses its id — and should reuse its cached cover rather than re-fetching and
 * re-encoding. A file is only removed once it has been orphaned for longer than
 * the grace period, judged by its **mtime**, which the cache already maintains.
 */

const DEFAULT_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
/** Content-addressed prefixes — no owning row, never sweepable this way. */
const CONTENT_PREFIXES = ['c_', 'r_'];
/** Refuse to sweep if this share of entity-keyed files looks orphaned. */
const SANITY_MAX_ORPHAN_RATIO = 0.9;
/**
 * …but only once there are enough files for that ratio to mean anything. Over a
 * handful of files the ratio is noise — a cache holding one orphan is 100 %
 * orphaned and would trip the valve forever, never reclaiming anything.
 */
const SANITY_MIN_SAMPLE = 20;

export interface CoverCachePruneResult {
  scanned: number;
  /** Skipped because they are content-addressed, not entity-keyed. */
  contentAddressed: number;
  orphaned: number;
  deleted: number;
  bytesReclaimed: number;
  /** Set when the sanity valve refused the sweep. */
  abortedReason?: string;
}

/** `abc123@320.webp` → `abc123`. */
export function cacheKeyBase(filename: string): string {
  const noExt = filename.replace(/\.[^.]+$/, '');
  const at = noExt.indexOf('@');
  return at === -1 ? noExt : noExt.slice(0, at);
}

export function isContentAddressed(base: string): boolean {
  return CONTENT_PREFIXES.some((p) => base.startsWith(p));
}

/** Every id a cover can legitimately be keyed on. */
function liveIds(db: Database): Set<string> {
  const ids = new Set<string>();
  for (const table of ['library_albums', 'library_artists', 'library_songs']) {
    try {
      for (const row of db.query<{ id: string }, []>(`SELECT id FROM ${table}`).all()) {
        ids.add(row.id);
      }
    } catch {
      // A schema-less DB (tests, a fresh boot) yields no ids; the sanity valve
      // below then refuses the sweep rather than deleting everything.
    }
  }
  return ids;
}

export function pruneCoverCache(
  db: Database,
  coverCacheDir: string,
  opts: { graceMs?: number; now?: number } = {},
): CoverCachePruneResult {
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const now = opts.now ?? Date.now();
  const result: CoverCachePruneResult = {
    scanned: 0,
    contentAddressed: 0,
    orphaned: 0,
    deleted: 0,
    bytesReclaimed: 0,
  };
  if (!existsSync(coverCacheDir)) return result;

  const live = liveIds(db);
  if (live.size === 0) {
    result.abortedReason = 'library has no rows — refusing to sweep';
    return result;
  }

  const candidates: Array<{ path: string; size: number; mtimeMs: number }> = [];
  let entityKeyed = 0;

  for (const name of readdirSync(coverCacheDir)) {
    result.scanned++;
    const base = cacheKeyBase(name);
    if (isContentAddressed(base)) {
      result.contentAddressed++;
      continue;
    }
    entityKeyed++;
    if (live.has(base)) continue;
    result.orphaned++;
    const full = join(coverCacheDir, name);
    try {
      const st = statSync(full);
      candidates.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      /* vanished under us — nothing to do */
    }
  }

  // A mid-rebuild or truncated library would make almost everything look
  // orphaned; that is a reason to stop, not to delete 3 GB.
  if (entityKeyed >= SANITY_MIN_SAMPLE && result.orphaned / entityKeyed > SANITY_MAX_ORPHAN_RATIO) {
    result.abortedReason = `${result.orphaned}/${entityKeyed} entity-keyed files look orphaned — refusing to sweep`;
    return result;
  }

  for (const file of candidates) {
    // mtime is the orphan clock: a re-downloaded file re-mints the same id and
    // the cache entry is served again, refreshing it.
    if (now - file.mtimeMs < graceMs) continue;
    try {
      rmSync(file.path);
      result.deleted++;
      result.bytesReclaimed += file.size;
    } catch {
      /* best-effort */
    }
  }

  return result;
}

const DAY_MARKER = 'cover_cache_prune_last_day';

/**
 * Once-a-day cover-cache sweep, marker-guarded like the backup and the orphan
 * row prune. `NICOTIND_COVER_CACHE_PRUNE=off` disables it.
 *
 * Returns whether it ran, so a caller can log it; a throw is swallowed because
 * cache housekeeping must never take down the processor tick.
 */
export function maybeRunDailyCoverCachePrune(
  db: Database,
  coverCacheDir: string | undefined,
  opts: { graceMs?: number; now?: number; enabled?: boolean } = {},
): CoverCachePruneResult | null {
  const enabled =
    opts.enabled ?? process.env.NICOTIND_COVER_CACHE_PRUNE?.trim().toLowerCase() !== 'off';
  if (!enabled || !coverCacheDir) return null;
  const now = opts.now ?? Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  try {
    const marker = db
      .query<{ value: string }, [string]>('SELECT value FROM library_sync_state WHERE key = ?')
      .get(DAY_MARKER);
    if (marker?.value === day) return null;
    const result = pruneCoverCache(db, coverCacheDir, { graceMs: opts.graceMs, now });
    db.run(
      `INSERT INTO library_sync_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [DAY_MARKER, day, now],
    );
    return result;
  } catch {
    return null;
  }
}
