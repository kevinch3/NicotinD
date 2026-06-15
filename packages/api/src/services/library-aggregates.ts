import type { Database } from 'bun:sqlite';

/**
 * Clean up an artist's aggregate rows after a release moved away from it (a
 * delete, or a metadata correction that re-assigned the album to a different
 * artist). Without this the orphaned `library_artists` row lingers until the
 * next *full* scan — the artist keeps showing in search and renders an empty
 * page. Extracted from the album-delete handler so the metadata-fix path reuses
 * the exact same logic. See docs/e2e-playground-findings-2026-06.md §D.
 */
export function pruneOrphanArtist(db: Database, artistId: string): void {
  const remainingAlbums =
    db
      .query<{ c: number }, [string]>('SELECT COUNT(*) AS c FROM library_albums WHERE artist_id = ?')
      .get(artistId)?.c ?? 0;
  const remainingSongs =
    db
      .query<{ c: number }, [string]>('SELECT COUNT(*) AS c FROM library_songs WHERE artist_id = ?')
      .get(artistId)?.c ?? 0;
  if (remainingAlbums === 0 && remainingSongs === 0) {
    db.run('DELETE FROM library_artists WHERE id = ?', [artistId]);
    db.run('DELETE FROM library_artwork WHERE id = ?', [artistId]);
  } else {
    // Keep the artist's album_count honest so cards aren't off-by-one.
    db.run('UPDATE library_artists SET album_count = ? WHERE id = ?', [remainingAlbums, artistId]);
  }
}
