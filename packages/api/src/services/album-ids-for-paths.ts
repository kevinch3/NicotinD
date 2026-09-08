import type { Database } from 'bun:sqlite';
import { SQL_PARAM_CHUNK, chunked, placeholders } from './sql-chunk.js';

/**
 * Album ids owning the given `library_songs.path` values.
 *
 * why: the enrichment lane reclassifies after writing release metadata, but it
 * has no scanner call to take ids from the way the download seam does, so it
 * resolves them from the paths it just enriched. Index-backed by
 * `idx_library_songs_path`.
 */
export function albumIdsForPaths(db: Database, relPaths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const chunk of chunked(relPaths, SQL_PARAM_CHUNK)) {
    for (const r of db
      .query<{ album_id: string }, string[]>(
        `SELECT DISTINCT album_id FROM library_songs WHERE path IN (${placeholders(chunk.length)})`,
      )
      .all(...chunk)) {
      out.add(r.album_id);
    }
  }
  return [...out];
}
