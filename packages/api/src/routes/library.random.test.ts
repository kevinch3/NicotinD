import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { libraryRoutes } from './library.js';

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

function seedSong(
  db: Database,
  s: { id: string; albumId: string; albumHidden?: boolean; analysed: boolean },
): void {
  db.run(
    `INSERT OR IGNORE INTO library_albums (id, name, artist, artist_id, song_count, duration, created, synced_at, hidden)
     VALUES (?, ?, 'A', 'A', 1, 0, '2024-01-01', 0, ?)`,
    [s.albumId, s.albumId, s.albumHidden ? 1 : 0],
  );
  db.run(
    `INSERT INTO library_songs
      (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type,
       created, landed_at, synced_at, bpm, energy)
     VALUES (?, ?, ?, 'A', 'A', 200, ?, 1000, 320, 'mp3', 'audio/mpeg', '2024-01-01', 1, 0, ?, ?)`,
    [s.id, s.albumId, s.id, `/m/${s.id}.mp3`, s.analysed ? 120 : null, s.analysed ? 0.5 : null],
  );
}

async function randomIds(app: Hono, size: number): Promise<string[]> {
  const res = await app.request(`/library/random?size=${size}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as Array<{ id: string }>).map((s) => s.id).sort();
}

describe('GET /library/random — feed eligibility', () => {
  let app: Hono;

  beforeEach(() => {
    testDb = new Database(':memory:');
    applySchema(testDb);
    app = new Hono();
    app.route('/library', libraryRoutes());
  });

  it('never draws a song whose album a curator hid', async () => {
    seedSong(testDb, { id: 'fine', albumId: 'alb', analysed: true });
    seedSong(testDb, { id: 'buried', albumId: 'hidden-alb', albumHidden: true, analysed: true });
    for (let i = 0; i < 5; i++) expect(await randomIds(app, 10)).toEqual(['fine']);
  });

  it('draws only vetted songs while they can fill the request', async () => {
    seedSong(testDb, { id: 'v1', albumId: 'a1', analysed: true });
    seedSong(testDb, { id: 'v2', albumId: 'a2', analysed: true });
    seedSong(testDb, { id: 'raw', albumId: 'a3', analysed: false });
    for (let i = 0; i < 5; i++) expect(await randomIds(app, 2)).toEqual(['v1', 'v2']);
  });

  it('tops up with un-analysed songs only when the vetted set is too small', async () => {
    seedSong(testDb, { id: 'v1', albumId: 'a1', analysed: true });
    seedSong(testDb, { id: 'raw', albumId: 'a3', analysed: false });
    expect(await randomIds(app, 5)).toEqual(['raw', 'v1']);
  });
});
