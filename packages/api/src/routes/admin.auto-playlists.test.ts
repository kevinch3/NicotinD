/**
 * Route tests for the admin automated-playlist controls (issue #228): admin
 * gate, cadence GET/PUT, and the manual "generate now" trigger.
 */
import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { JwtPayload } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { applySchema } from '../db.js';
import { adminRoutes } from './admin.js';

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

function authed(app: Hono<AuthEnv>, role: 'admin' | 'user' = 'admin'): Hono<AuthEnv> {
  const wrap = new Hono<AuthEnv>();
  wrap.use('*', async (c, next) => {
    c.set('user', { sub: 'admin', username: 'admin', role, iat: 0, exp: 0 } as JwtPayload);
    await next();
  });
  wrap.route('/', app);
  return wrap;
}

function seedLibrary(db: Database): void {
  db.run(
    "INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('admin', 'admin', 'x', 'admin', '2020-01-01')",
  );
  for (let i = 0; i < 30; i++) {
    db.run(
      `INSERT INTO library_songs
         (id, album_id, title, artist, artist_id, duration, year, genre, path, bpm, key, hidden, landed_at, synced_at)
       VALUES (?, 'al', ?, ?, ?, 200, 2015, 'Electronic', ?, ?, 'C major', 0, 1, 0)`,
      [`s${i}`, `t${i}`, `Artist-${i}`, `art-${i}`, `/m/${i}.flac`, 128 + (i % 10)],
    );
  }
}

beforeEach(() => {
  testDb = new Database(':memory:');
  applySchema(testDb);
  seedLibrary(testDb);
});

describe('admin auto-playlist routes', () => {
  it('rejects non-admins', async () => {
    const app = authed(adminRoutes({ musicDir: '/music' }), 'user');
    expect((await app.request('/playlists/auto')).status).toBe(403);
  });

  it('reports the default weekly cadence and no prior refresh', async () => {
    const app = authed(adminRoutes({ musicDir: '/music' }));
    const res = await app.request('/playlists/auto');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cadence: 'weekly', lastRefreshedAt: null });
  });

  it('PUT changes the cadence and rejects an unknown value', async () => {
    const app = authed(adminRoutes({ musicDir: '/music' }));
    const ok = await app.request('/playlists/auto', {
      method: 'PUT',
      body: JSON.stringify({ cadence: 'daily' }),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).cadence).toBe('daily');

    const bad = await app.request('/playlists/auto', {
      method: 'PUT',
      body: JSON.stringify({ cadence: 'hourly' }),
    });
    expect(bad.status).toBe(400);
  });

  it('POST /refresh materializes shelves now and records the timestamp', async () => {
    const app = authed(adminRoutes({ musicDir: '/music' }));
    const res = await app.request('/playlists/auto/refresh', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.shelves.length).toBeGreaterThan(0);
    expect(body.lastRefreshedAt).toBeGreaterThan(0);

    const count = testDb
      .query<{ n: number }, []>("SELECT COUNT(*) n FROM playlists WHERE kind='curated'")
      .get();
    expect(count!.n).toBeGreaterThan(0);
    // Audit-logged.
    const audit = testDb
      .query<{ n: number }, []>(
        "SELECT COUNT(*) n FROM audit_log WHERE action='auto_playlists.refresh'",
      )
      .get();
    expect(audit!.n).toBe(1);
  });
});
