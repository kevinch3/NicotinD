/**
 * Route tests for metadata optimization: the per-album library endpoint and the
 * library-wide admin endpoint (admin gate, Lidarr-unconfigured 503, match/404).
 */
import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { JwtPayload } from '@nicotind/core';
import type { Lidarr } from '@nicotind/lidarr-client';
import type { AuthEnv } from '../middleware/auth.js';
import { applySchema } from '../db.js';
import { libraryRoutes } from './library.js';
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

function seedAlbum(id: string, name: string, artist: string): void {
  testDb.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
     VALUES (?, ?, ?, 'art', 8, 0, 0)`,
    [id, name, artist],
  );
}

const lidarr = {
  album: {
    lookup: async () => [
      {
        title: 'Drukqs',
        albumType: 'Album',
        releaseDate: '2001-01-01',
        images: [{ coverType: 'cover', remoteUrl: 'https://img/d.jpg', url: 'x' }],
        artist: { artistName: 'Aphex Twin' },
      },
    ],
  },
} as unknown as Lidarr;

function authed(app: Hono<AuthEnv>, role: 'admin' | 'user' = 'admin'): Hono<AuthEnv> {
  const wrap = new Hono<AuthEnv>();
  wrap.use('*', async (c, next) => {
    c.set('user', { sub: 'u1', role, iat: 0, exp: 0 } as JwtPayload);
    await next();
  });
  wrap.route('/', app);
  return wrap;
}

describe('POST /albums/:id/optimize-metadata', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    applySchema(testDb);
    seedAlbum('alb-1', 'Drukqs', 'Aphex Twin');
  });

  it('optimizes an album for an admin', async () => {
    const app = authed(new Hono<AuthEnv>().route('/', libraryRoutes('/music', { lidarr })), 'admin');
    const res = await app.request('/albums/alb-1/optimize-metadata', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { matched: boolean; coverUpdated: boolean };
    expect(body.matched).toBe(true);
    expect(body.coverUpdated).toBe(true);
  });

  it('403 for a non-admin', async () => {
    const app = authed(new Hono<AuthEnv>().route('/', libraryRoutes('/music', { lidarr })), 'user');
    const res = await app.request('/albums/alb-1/optimize-metadata', { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('503 when Lidarr is unconfigured', async () => {
    const app = authed(
      new Hono<AuthEnv>().route('/', libraryRoutes('/music', { lidarr: null })),
      'admin',
    );
    const res = await app.request('/albums/alb-1/optimize-metadata', { method: 'POST' });
    expect(res.status).toBe(503);
  });

  it('404 when no Lidarr match', async () => {
    const noMatch = {
      album: { lookup: async () => [{ title: 'Other', artist: { artistName: 'Nobody' } }] },
    } as unknown as Lidarr;
    const app = authed(
      new Hono<AuthEnv>().route('/', libraryRoutes('/music', { lidarr: noMatch })),
      'admin',
    );
    const res = await app.request('/albums/alb-1/optimize-metadata', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('POST /admin/metadata-optimize', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    applySchema(testDb);
    seedAlbum('alb-1', 'Drukqs', 'Aphex Twin'); // no artwork → a candidate
  });

  it('503 when Lidarr is unconfigured', async () => {
    const app = authed(
      new Hono<AuthEnv>().route('/', adminRoutes({ musicDir: '/music', lidarr: null })),
      'admin',
    );
    const res = await app.request('/metadata-optimize', { method: 'POST' });
    expect(res.status).toBe(503);
  });

  it('runs the batch for an admin', async () => {
    const app = authed(
      new Hono<AuthEnv>().route('/', adminRoutes({ musicDir: '/music', lidarr })),
      'admin',
    );
    const res = await app.request('/metadata-optimize', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; coversUpdated: number };
    expect(body.ok).toBe(true);
    expect(body.coversUpdated).toBe(1);
  });
});
