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
      .query<{ c: number }, [string]>(
        'SELECT COUNT(*) AS c FROM library_albums WHERE artist_id = ?',
      )
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

/**
 * Recompute one album's `song_count` / `duration` from the songs it currently
 * has. `library_albums` carries these as a scan-time snapshot, so every path
 * that adds or removes a song must refresh them or the album keeps reporting a
 * stale count until the next *full* scan (issue #774).
 */
export function refreshAlbumAggregate(db: Database, albumId: string): void {
  db.run(
    `UPDATE library_albums SET
       song_count = (SELECT COUNT(*) FROM library_songs WHERE album_id = ?),
       duration   = (SELECT COALESCE(SUM(duration), 0) FROM library_songs WHERE album_id = ?)
     WHERE id = ?`,
    [albumId, albumId, albumId],
  );
}

/**
 * Refresh an album's aggregates and, when it just lost its last song, drop the
 * album row (and any artist it orphans) instead of leaving an empty shell that
 * still renders a card. Returns whether the album row was removed.
 *
 * The counterpart of {@link pruneOrphanArtist} one level down, and the shared
 * form of what the scanner's own missing-file prune has always done — a
 * single-song delete needs the identical cleanup.
 */
export function pruneOrphanAlbum(db: Database, albumId: string): boolean {
  refreshAlbumAggregate(db, albumId);
  const remaining =
    db
      .query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM library_songs WHERE album_id = ?')
      .get(albumId)?.n ?? 0;
  if (remaining > 0) return false;

  const artistId = db
    .query<{ artist_id: string | null }, [string]>(
      'SELECT artist_id FROM library_albums WHERE id = ?',
    )
    .get(albumId)?.artist_id;
  db.run('DELETE FROM library_albums WHERE id = ?', [albumId]);
  db.run('DELETE FROM library_album_artists WHERE album_id = ?', [albumId]);
  if (artistId) pruneOrphanArtist(db, artistId);
  return true;
}
