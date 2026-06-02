import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { libraryRoutes } from './library.js';

type SimilarSong = { id: string; artist: string; title: string };

let testDb: Database = (() => {
  const d = new Database(':memory:');
  applySchema(d);
  return d;
})();

mock.module('../db.js', () => ({
  getDatabase: () => testDb,
  initDatabase: () => testDb,
  applySchema,
}));

function seedAlbum(
  db: Database,
  a: { id: string; name: string; artist: string; artistId: string; songCount: number; created: string },
): void {
  db.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, created, synced_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, 0)`,
    [a.id, a.name, a.artist, a.artistId, a.songCount, a.created],
  );
}

function seedSong(
  db: Database,
  s: {
    id: string; title: string; artist: string; artistId: string;
    albumId: string; genre?: string; year?: number; path: string;
  },
): void {
  db.run(
    `INSERT INTO library_songs
      (id, album_id, title, artist, artist_id, duration, year, genre, path,
       size, bit_rate, suffix, content_type, created, synced_at)
     VALUES (?, ?, ?, ?, ?, 180, ?, ?, ?, 1000, 320, 'flac', 'audio/flac', '2024-01-01', 0)`,
    [s.id, s.albumId, s.title, s.artist, s.artistId, s.year ?? null, s.genre ?? null, s.path],
  );
}

describe('GET /songs/:id/similar', () => {
  let app: Hono;

  beforeEach(() => {
    testDb = new Database(':memory:');
    applySchema(testDb);

    seedAlbum(testDb, { id: 'album-1', name: 'Album X', artist: 'Artist A', artistId: 'artist-1', songCount: 2, created: '2024-01-01' });
    seedAlbum(testDb, { id: 'album-2', name: 'Album Y', artist: 'Artist A', artistId: 'artist-1', songCount: 1, created: '2023-01-01' });

    seedSong(testDb, { id: 'song-src', title: 'Source', artist: 'Artist A', artistId: 'artist-1', albumId: 'album-1', genre: 'Jazz', year: 2010, path: '/music/Jazz/Artist A/Album X/song.flac' });
    seedSong(testDb, { id: 'song-a2', title: 'Track 2', artist: 'Artist A', artistId: 'artist-1', albumId: 'album-1', genre: 'Jazz', year: 2010, path: '/music/Jazz/Artist A/Album X/track2.flac' });
    seedSong(testDb, { id: 'song-b1', title: 'B Track 1', artist: 'Artist A', artistId: 'artist-1', albumId: 'album-2', genre: 'Jazz', year: 2010, path: '/music/Jazz/Artist A/Album Y/btrack1.flac' });
    seedSong(testDb, { id: 'song-g1', title: 'Genre Track', artist: 'Artist B', artistId: 'artist-2', albumId: 'album-3', genre: 'Jazz', year: 2012, path: '/music/Jazz/Artist B/Album Z/genre.flac' });

    app = new Hono();
    app.route('/', libraryRoutes('/music'));
  });

  afterEach(() => {
    testDb.close();
  });

  it('returns similar songs excluding the source song', async () => {
    const res = await app.request('/songs/song-src/similar?size=20');
    expect(res.status).toBe(200);
    const body = await res.json() as SimilarSong[];
    expect(body.find((s) => s.id === 'song-src')).toBeUndefined();
  });

  it('includes same-artist songs', async () => {
    const res = await app.request('/songs/song-src/similar?size=20');
    const body = await res.json() as SimilarSong[];
    expect(body.find((s) => s.id === 'song-b1')).toBeDefined();
  });

  it('includes same-album songs', async () => {
    const res = await app.request('/songs/song-src/similar?size=20');
    const body = await res.json() as SimilarSong[];
    expect(body.find((s) => s.id === 'song-a2')).toBeDefined();
  });

  it('includes genre songs', async () => {
    const res = await app.request('/songs/song-src/similar?size=20');
    const body = await res.json() as SimilarSong[];
    expect(body.find((s) => s.id === 'song-g1')).toBeDefined();
  });

  it('ranks same-artist songs above genre-only songs', async () => {
    const res = await app.request('/songs/song-src/similar?size=20');
    const body = await res.json() as SimilarSong[];
    const artistIdx = body.findIndex((s) => s.artist === 'Artist A');
    const genreIdx = body.findIndex((s) => s.id === 'song-g1');
    expect(artistIdx).toBeLessThan(genreIdx);
  });

  it('returns 404 for unknown song id', async () => {
    const res = await app.request('/songs/nonexistent/similar');
    expect(res.status).toBe(404);
  });

  it('caps results at the requested size', async () => {
    const res = await app.request('/songs/song-src/similar?size=2');
    const body = await res.json() as SimilarSong[];
    expect(body.length).toBeLessThanOrEqual(2);
  });
});
