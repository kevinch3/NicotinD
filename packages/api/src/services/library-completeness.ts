import type { Database } from 'bun:sqlite';
import { normalizeForGrouping } from './album-grouping.js';

/**
 * True when the library already holds this album (same artist, same
 * edition-stripped title) with at least as many songs as its canonical
 * tracklist. Uses `normalizeForGrouping` so deluxe/remaster editions of an album
 * we already have are treated as "complete" and don't get re-acquired.
 *
 * Shared by the hunt-download route (duplicate-acquisition guard) and the
 * watchlist poller (so a watched album already on disk resolves immediately).
 */
export function albumAlreadyComplete(
  db: Database,
  artist: string,
  title: string,
  trackCount: number,
): boolean {
  const targetName = normalizeForGrouping(title);
  const rows = db
    .query<{ name: string; song_count: number }, [string]>(
      `SELECT name, song_count FROM library_albums WHERE artist = ? COLLATE NOCASE`,
    )
    .all(artist);
  return rows.some((r) => normalizeForGrouping(r.name) === targetName && r.song_count >= trackCount);
}
