/**
 * Route tests for the per-user like endpoints (issue #225): POST/DELETE
 * /songs/:id/like toggle membership in the auto-maintained "Liked Songs"
 * playlist; GET /liked-ids hydrates the client heart state.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { JwtPayload } from '@nicotind/core';
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

function createTestDb(): Database {
  const db = new Database(':memory:');
  applySchema(db);
  db.run(
    "INSERT INTO users (id, username, password_hash) VALUES ('u1', 'a', 'x'), ('u2', 'b', 'y')",
  );
  db.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, created, synced_at, hidden)
     VALUES ('al', 'Album', 'A', 'art', 1, 0, '2026-01-01', 0, 0)`,
  );
  for (const id of ['s1', 's2']) {
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, landed_at, synced_at, hidden)
       VALUES (?, 'al', ?, 'A', 'art', 60, ?, 1, 0, 0)`,
      [id, id, `/m/${id}.mp3`],
    );
  }
  return db;
}

/** Mount the library routes behind a middleware that sets the auth'd user. */
function appAs(userId: string): Hono<AuthEnv> {
  const wrap = new Hono<AuthEnv>();
  wrap.use('*', async (c, next) => {
    c.set('user', { sub: userId, username: userId, role: 'user', iat: 0, exp: 0 } as JwtPayload);
    await next();
  });
  wrap.route('/', libraryRoutes('/music'));
  return wrap;
}

beforeEach(() => {
  testDb = createTestDb();
});
afterEach(() => testDb.close());

describe('library like routes', () => {
  it('likes and unlikes a song, reflected in /liked-ids', async () => {
    const app = appAs('u1');

    expect(await (await app.request('/liked-ids')).json()).toEqual({ ids: [] });

    const liked = await app.request('/songs/s1/like', { method: 'POST' });
    expect(liked.status).toBe(200);
    expect(await liked.json()).toEqual({ liked: true });
    expect(await (await app.request('/liked-ids')).json()).toEqual({ ids: ['s1'] });

    const unliked = await app.request('/songs/s1/like', { method: 'DELETE' });
    expect(unliked.status).toBe(200);
    expect(await unliked.json()).toEqual({ liked: false });
    expect(await (await app.request('/liked-ids')).json()).toEqual({ ids: [] });
  });

  it('404s liking a song that does not exist', async () => {
    const res = await appAs('u1').request('/songs/nope/like', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('keeps likes isolated per user', async () => {
    await appAs('u1').request('/songs/s1/like', { method: 'POST' });
    expect(await (await appAs('u2').request('/liked-ids')).json()).toEqual({ ids: [] });
  });

  it('is idempotent (double-like stays a single id)', async () => {
    const app = appAs('u1');
    await app.request('/songs/s1/like', { method: 'POST' });
    await app.request('/songs/s1/like', { method: 'POST' });
    expect(await (await app.request('/liked-ids')).json()).toEqual({ ids: ['s1'] });
  });
});
