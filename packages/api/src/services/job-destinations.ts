import type { Database } from 'bun:sqlite';
import type { AcquireAlbumDestination } from '@nicotind/core';

/**
 * Where a job's files actually landed — derived from the scanned items, not
 * from a `storage_path` (the addon pipeline organizes per file and never
 * records one). Observed truth, so it names a finished card ("Discovery", not
 * "YouTube download") and drives the "View N albums" menu.
 *
 * Extracted from `addon-url-jobs.project()` when the unified feed needed the
 * same answer: a second inline copy is exactly the duplication
 * `check:shared-helpers` exists to catch. Best-effort by design — a minimal DB
 * without the library tables must still render a feed.
 */
export function jobDestinationAlbums(db: Database, jobId: string): AcquireAlbumDestination[] {
  try {
    return db
      .query<{ id: string; name: string; artist: string }, [string]>(
        `SELECT DISTINCT al.id, al.name, al.artist
           FROM acquisition_job_items i
           JOIN library_songs s ON s.id = i.song_id
           JOIN library_albums al ON al.id = s.album_id
          WHERE i.job_id = ?`,
      )
      .all(jobId)
      .map((r) => ({ albumId: r.id, albumArtist: r.artist, albumTitle: r.name }));
  } catch {
    return [];
  }
}
