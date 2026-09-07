import type { Database } from 'bun:sqlite';
import { pickDisplayName } from './album-grouping.js';

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
 * Re-derive the album's DISPLAYED artist spelling from the songs it currently
 * holds (issue #958).
 *
 * **This half is load-bearing, not a tidy-up.** `scanPaths` builds from only the
 * touched files, so a reduction computed inside `buildLibrary` alone is a
 * reduction over the *batch*, not the album — and a one-track incremental would
 * still write a one-sample answer. That is exactly how one loose single, scanned
 * four hours after the full scan, renamed a 23-track album from
 * `Gigi D'Agostino` to `GIGI D'AGOSTINO`.
 *
 * `artist_id` is never touched: every candidate folds to the same id, so this
 * only chooses which of them is shown.
 *
 * Deliberately NOT called from `refreshAlbumAggregate`, although #958 proposed
 * exactly that. `applyMetadataFix` calls the aggregate refresh too, and it
 * updates `library_songs.artist` **without** touching `album_artist` — so the
 * recompute read a stale `album_artist` and silently reverted a curator's
 * explicit rename. An e2e caught it. A derived value must never overwrite a
 * deliberate correction, so this stays on the scan path, where the input really
 * is the files' own tags.
 */
export function refreshAlbumArtistDisplay(db: Database, albumId: string): void {
  const spellings = db
    .query<{ album_artist: string | null; artist: string | null }, [string]>(
      'SELECT album_artist, artist FROM library_songs WHERE album_id = ?',
    )
    .all(albumId)
    .map((r) => (r.album_artist?.trim() ? r.album_artist : r.artist))
    .filter((v): v is string => !!v && v.trim().length > 0);
  if (spellings.length === 0) return;
  db.run('UPDATE library_albums SET artist = ? WHERE id = ?', [
    pickDisplayName(spellings),
    albumId,
  ]);
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
