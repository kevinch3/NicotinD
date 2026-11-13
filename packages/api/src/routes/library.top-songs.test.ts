import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { libraryRoutes } from './library.js';
import { TOP_SONGS_MAX } from '../services/artist-top-songs.js';

let seq = 0;
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

function seedSong(id: string, popularity: number | null): void {
  testDb.run(
    `INSERT INTO library_songs
       (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix,
        content_type, created, landed_at, synced_at, popularity)
     VALUES (?, 'alb', ?, 'Artist', 'art', ?, ?, 1000, 320, 'opus', 'audio/ogg', '2024-01-01', 1, 0, ?)`,
    [id, id, 100 + ++seq, `/m/${id}.opus`, popularity],
  );
  testDb.run(
    `INSERT INTO library_song_artists (song_id, artist_id, role, position) VALUES (?, 'art', 'primary', 0)`,
    [id],
  );
}

describe('GET /artists/:id/top-songs', () => {
  let app: Hono;

  beforeEach(() => {
    testDb = new Database(':memory:');
    applySchema(testDb);
    testDb.run(
      `INSERT INTO library_artists (id, name, album_count, synced_at) VALUES ('art', 'Artist', 1, 0)`,
    );
    testDb.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, created, synced_at)
       VALUES ('alb', 'Album', 'Artist', 'art', 1, 0, '2024-01-01', 0)`,
    );
    app = new Hono();
    app.route('/', libraryRoutes('/music'));
  });

  it('404s for an unknown artist', async () => {
    expect((await app.request('/artists/nope/top-songs')).status).toBe(404);
  });

  it('answers [] when nothing ranks', async () => {
    seedSong('silent', null);
    const res = await app.request('/artists/art/top-songs');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('returns whole songs, best first, with their credits and album', async () => {
    seedSong('deep-cut', 0.1);
    seedSong('hit', 0.9);
    seedSong('silent', null);
    const songs = (await (await app.request('/artists/art/top-songs')).json()) as Array<{
      id: string;
      album: string;
      popularity: number;
      artists: Array<{ id: string }>;
    }>;
    expect(songs.map((s) => s.id)).toEqual(['hit', 'deep-cut']);
    expect(songs[0]).toMatchObject({ album: 'Album', popularity: 0.9 });
    expect(songs[0]!.artists.map((a) => a.id)).toEqual(['art']);
  });

  it('defaults to five and clamps the limit', async () => {
    for (let i = 0; i < TOP_SONGS_MAX + 3; i++) seedSong(`s${i}`, 0.5 + i / 1000);
    const count = async (q: string) =>
      ((await (await app.request(`/artists/art/top-songs${q}`)).json()) as unknown[]).length;
    expect(await count('')).toBe(5);
    expect(await count('?limit=2')).toBe(2);
    expect(await count('?limit=999')).toBe(TOP_SONGS_MAX);
    expect(await count('?limit=junk')).toBe(5);
  });
});
