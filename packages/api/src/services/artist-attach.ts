import type { Database } from 'bun:sqlite';
import type { Song, Album } from '@nicotind/core';

export function attachSongArtists(db: Database, songs: Song[]): void {
  if (songs.length === 0) return;
  const ids = songs.map((s) => s.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .query<{ song_id: string; artist_id: string; name: string; role: string; position: number }, string[]>(
      `SELECT sa.song_id, sa.artist_id, a.name, sa.role, sa.position
       FROM library_song_artists sa
       JOIN library_artists a ON a.id = sa.artist_id
       WHERE sa.song_id IN (${placeholders})
       ORDER BY sa.position`,
    )
    .all(...ids);
  const map = new Map<string, Array<{ id: string; name: string; role: 'primary' | 'featuring' }>>();
  for (const r of rows) {
    const arr = map.get(r.song_id) ?? [];
    arr.push({ id: r.artist_id, name: r.name, role: r.role as 'primary' | 'featuring' });
    map.set(r.song_id, arr);
  }
  for (const song of songs) {
    const artists = map.get(song.id);
    if (artists && artists.length > 0) song.artists = artists;
  }
}

export function attachAlbumArtists(db: Database, albums: Album[]): void {
  if (albums.length === 0) return;
  const ids = albums.map((a) => a.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .query<{ album_id: string; artist_id: string; name: string; role: string; position: number }, string[]>(
      `SELECT aa.album_id, aa.artist_id, a.name, aa.role, aa.position
       FROM library_album_artists aa
       JOIN library_artists a ON a.id = aa.artist_id
       WHERE aa.album_id IN (${placeholders})
       ORDER BY aa.position`,
    )
    .all(...ids);
  const map = new Map<string, Array<{ id: string; name: string; role: 'primary' | 'featuring' }>>();
  for (const r of rows) {
    const arr = map.get(r.album_id) ?? [];
    arr.push({ id: r.artist_id, name: r.name, role: r.role as 'primary' | 'featuring' });
    map.set(r.album_id, arr);
  }
  for (const album of albums) {
    const artists = map.get(album.id);
    if (artists && artists.length > 0) album.artists = artists;
  }
}
