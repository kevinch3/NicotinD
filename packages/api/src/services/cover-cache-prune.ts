import type { Database } from 'bun:sqlite';
import { readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DISK_ART_PREFIX, DISK_ART_REF_EXT, readDiskArtRefFile } from './disk-art-cache.js';

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
 * ## Source-keyed disk art (#1310)
 *
 * On-disk art is stored once per image as `d_<sha1>`, with a `<id>.ref` pointer
 * per song/album id. The pointer is entity-keyed and swept like any other; a
 * `d_` file is live while a live id's pointer names it, and swept (after grace)
 * once none does. The un-prefixed `<songId>` / `<albumId>` image files the old
 * per-id cache wrote are never read again, so they are reclaimed as
 * **superseded** — immediately, because their owner being alive is exactly why
 * the orphan rule could never reach them. Un-prefixed files keyed on an artist
 * id are an override's thumbnails, still read, and keep the orphan rule.
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
  /** Legacy per-song/per-album images the source-keyed cache replaced (#1310). */
  superseded: number;
  /** `d_` images no live id's `.ref` points at any more. */
  unreferenced: number;
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

interface LiveIds {
  all: Set<string>;
  /** Song + album ids — the ids whose on-disk art is now source-keyed. */
  diskArt: Set<string>;
}

/** Every id a cover can legitimately be keyed on. */
function liveIds(db: Database): LiveIds {
  const all = new Set<string>();
  const diskArt = new Set<string>();
  for (const table of ['library_albums', 'library_artists', 'library_songs']) {
    try {
      for (const row of db.query<{ id: string }, []>(`SELECT id FROM ${table}`).all()) {
        all.add(row.id);
        if (table !== 'library_artists') diskArt.add(row.id);
      }
    } catch {
      // A schema-less DB (tests, a fresh boot) yields no ids; the sanity valve
      // below then refuses the sweep rather than deleting everything.
    }
  }
  return { all, diskArt };
}

interface Candidate {
  path: string;
  size: number;
  mtimeMs: number;
}

function statCandidate(path: string): Candidate | null {
  try {
    const st = statSync(path);
    return { path, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null; // vanished under us — nothing to do
  }
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
    superseded: 0,
    unreferenced: 0,
    deleted: 0,
    bytesReclaimed: 0,
  };
  if (!existsSync(coverCacheDir)) return result;

  const live = liveIds(db);
  if (live.all.size === 0) {
    result.abortedReason = 'library has no rows — refusing to sweep';
    return result;
  }

  const orphans: Candidate[] = [];
  const superseded: Candidate[] = [];
  const diskArtFiles: Array<{ name: string; base: string }> = [];
  const referenced = new Set<string>();
  let entityKeyed = 0;

  for (const name of readdirSync(coverCacheDir)) {
    result.scanned++;
    const base = cacheKeyBase(name);
    if (base.startsWith(DISK_ART_PREFIX)) {
      diskArtFiles.push({ name, base });
      continue;
    }
    if (isContentAddressed(base)) {
      result.contentAddressed++;
      continue;
    }
    entityKeyed++;
    const full = join(coverCacheDir, name);
    if (!live.all.has(base)) {
      result.orphaned++;
      const c = statCandidate(full);
      if (c) orphans.push(c);
      continue;
    }
    if (name.endsWith(DISK_ART_REF_EXT)) {
      const ref = readDiskArtRefFile(full);
      if (ref) referenced.add(ref.key);
    } else if (live.diskArt.has(base)) {
      result.superseded++;
      const c = statCandidate(full);
      if (c) superseded.push(c);
    }
  }

  // A mid-rebuild or truncated library would make almost everything look
  // orphaned; that is a reason to stop, not to delete 3 GB.
  if (entityKeyed >= SANITY_MIN_SAMPLE && result.orphaned / entityKeyed > SANITY_MAX_ORPHAN_RATIO) {
    result.abortedReason = `${result.orphaned}/${entityKeyed} entity-keyed files look orphaned — refusing to sweep`;
    return result;
  }

  const unreferenced: Candidate[] = [];
  for (const f of diskArtFiles) {
    result.contentAddressed++;
    if (referenced.has(f.base)) continue;
    result.unreferenced++;
    const c = statCandidate(join(coverCacheDir, f.name));
    if (c) unreferenced.push(c);
  }

  const remove = (file: Candidate) => {
    try {
      rmSync(file.path);
      result.deleted++;
      result.bytesReclaimed += file.size;
    } catch {
      /* best-effort */
    }
  };
  // Superseded files are never read again, so no grace applies to them.
  for (const file of superseded) remove(file);
  for (const file of [...orphans, ...unreferenced]) {
    // mtime is the orphan clock: a re-downloaded file re-mints the same id and
    // the cache entry is served again, refreshing it. For a `d_` image it keeps
    // one just written by a request whose `.ref` is still landing.
    if (now - file.mtimeMs < graceMs) continue;
    remove(file);
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
