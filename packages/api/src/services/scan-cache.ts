import type { Database } from 'bun:sqlite';
import type { ScannedTrack } from './library-scanner.js';

/** A stat'd file awaiting a cache decision. `relPath` is the cache key. */
export interface FileStat {
  abs: string;
  relPath: string;
  size: number;
  mtimeMs: number;
}

/** In-memory view of the `scan_cache` table, keyed by relative path. */
export type ScanCache = Map<string, { size: number; mtimeMs: number; track: ScannedTrack }>;

/**
 * Pure split of stat'd files into cache hits (reuse the stored raw track, no
 * re-parse) and misses (size/mtime changed or never seen — must parse). A file
 * is a hit only when BOTH size and mtime match, so any edit re-parses.
 */
export function partitionByCache(
  files: FileStat[],
  cache: ScanCache,
): { hits: ScannedTrack[]; misses: FileStat[] } {
  const hits: ScannedTrack[] = [];
  const misses: FileStat[] = [];
  for (const f of files) {
    const c = cache.get(f.relPath);
    if (c && c.size === f.size && c.mtimeMs === f.mtimeMs) {
      hits.push(c.track);
    } else {
      misses.push(f);
    }
  }
  return { hits, misses };
}

/** Load the whole scan cache into memory. Missing table → empty (fresh DB). */
export function loadScanCache(db: Database): ScanCache {
  const map: ScanCache = new Map();
  let rows: Array<{ path: string; size: number; mtime_ms: number; track_json: string }>;
  try {
    rows = db
      .query<{ path: string; size: number; mtime_ms: number; track_json: string }, []>(
        `SELECT path, size, mtime_ms, track_json FROM scan_cache`,
      )
      .all();
  } catch {
    return map;
  }
  for (const r of rows) {
    try {
      map.set(r.path, {
        size: r.size,
        mtimeMs: r.mtime_ms,
        track: JSON.parse(r.track_json) as ScannedTrack,
      });
    } catch {
      // Corrupt row — drop it; the file will simply be re-parsed as a miss.
    }
  }
  return map;
}

/** Upsert the given raw tracks into the cache in one transaction. */
export function saveScanCache(db: Database, tracks: ScannedTrack[]): void {
  const stmt = db.prepare(
    `INSERT INTO scan_cache (path, size, mtime_ms, track_json) VALUES (?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       size = excluded.size,
       mtime_ms = excluded.mtime_ms,
       track_json = excluded.track_json`,
  );
  const tx = db.transaction((ts: ScannedTrack[]) => {
    for (const t of ts) stmt.run(t.relPath, t.size, t.mtimeMs, JSON.stringify(t));
  });
  tx(tracks);
}
