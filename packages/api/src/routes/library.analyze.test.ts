/**
 * Route tests for on-demand BPM analysis + genre verification. Covers the
 * deterministic, no-ffmpeg paths: tag-first BPM, missing-file handling, the
 * genre suggestion via a stubbed Lidarr, and the admin-gated apply.
 */
import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { JwtPayload } from '@nicotind/core';
import type { Lidarr } from '@nicotind/lidarr-client';
import type { AuthEnv } from '../middleware/auth.js';
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

function seedSong(db: Database, s: { id: string; bpm?: number; genre?: string }): void {
  db.run(
    `INSERT INTO library_songs
      (id, album_id, title, artist, artist_id, duration, genre, bpm, path,
       size, bit_rate, suffix, content_type, created, synced_at)
     VALUES (?, 'album-1', 'Avril 14th', 'Aphex Twin', 'artist-1', 120, ?, ?,
       'Aphex Twin/Drukqs/01 - Avril 14th.flac', 1000, 1000, 'flac', 'audio/flac', '2024-01-01', 0)`,
    [s.id, s.genre ?? null, s.bpm ?? null],
  );
}

const lidarr = {
  artist: {
    lookup: async () => [{ artistName: 'Aphex Twin', genres: ['Electronic', 'IDM'] }],
  },
} as unknown as Lidarr;

function makeApp(role: 'admin' | 'user' = 'admin'): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { sub: 'u1', role, iat: 0, exp: 0 } as JwtPayload);
    await next();
  });
  app.route('/', libraryRoutes('/music', { lidarr }));
  return app;
}

describe('POST /songs/:id/analyze', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    applySchema(testDb);
  });
  afterEach(() => testDb.close());

  it('returns an existing bpm tag without analyzing', async () => {
    seedSong(testDb, { id: 'song-1', bpm: 128 });
    const res = await makeApp().request('/songs/song-1/analyze', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bpm: 128, source: 'tag' });
  });

  it('404s for an unknown song', async () => {
    const res = await makeApp().request('/songs/nope/analyze', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('404s when the bpm is unknown and the file is missing', async () => {
    seedSong(testDb, { id: 'song-2' }); // no bpm, file not on disk under /music
    const res = await makeApp().request('/songs/song-2/analyze', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('GET /songs/:id/genre-suggestion', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    applySchema(testDb);
  });
  afterEach(() => testDb.close());

  it('returns current + suggested genre from lidarr', async () => {
    seedSong(testDb, { id: 'song-1', genre: 'IDM' });
    const res = await makeApp().request('/songs/song-1/genre-suggestion');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { current: string; suggested: string; source: string };
    expect(body.current).toBe('IDM');
    expect(body.suggested).toBe('Electronic');
    expect(body.source).toBe('lidarr');
  });
});

describe('POST /songs/:id/genre', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    applySchema(testDb);
  });
  afterEach(() => testDb.close());

  it('updates the genre for an admin', async () => {
    seedSong(testDb, { id: 'song-1', genre: 'IDM' });
    const res = await makeApp('admin').request('/songs/song-1/genre', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ genre: 'Electronic' }),
    });
    expect(res.status).toBe(200);
    const row = testDb
      .query<{ genre: string }, [string]>('SELECT genre FROM library_songs WHERE id = ?')
      .get('song-1');
    expect(row?.genre).toBe('Electronic');
  });

  it('rejects a non-admin', async () => {
    seedSong(testDb, { id: 'song-1', genre: 'IDM' });
    const res = await makeApp('user').request('/songs/song-1/genre', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ genre: 'Electronic' }),
    });
    expect(res.status).toBe(403);
  });
});
