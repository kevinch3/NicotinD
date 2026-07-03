/**
 * Route tests for the windowed library-processing admin endpoints: admin gate,
 * 503 when the service isn't wired, settings GET/PUT (validation), and run/stop.
 */
import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { JwtPayload } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { applySchema } from '../db.js';
import { adminRoutes } from './admin.js';
import { LibraryProcessingService } from '../services/library-processing.service.js';

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
    c.set('user', { sub: 'u1', role, iat: 0, exp: 0 } as JwtPayload);
    await next();
  });
  wrap.route('/', app);
  return wrap;
}

function makeService(): LibraryProcessingService {
  return new LibraryProcessingService({
    db: testDb,
    lidarr: null,
    musicDir: '/music',
    dataDir: '/tmp',
    logToFile: false,
    // Never let a real run touch ffmpeg/Lidarr in a route test.
    contextFactory: () => ({
      musicDir: '/music',
      coverCacheDir: '/tmp/cover-cache',
      lidarr: null,
      concurrency: 1,
      ffmpegAvailable: () => false,
      readTags: async () => ({}),
      writeTags: async () => true,
      analyzeBpm: async () => null,
      analyzeKey: async () => null,
      analyzeLoudness: async () => null,
      lookupGenre: async () => null,
      lookupArtistImageSpotify: null,
      fileExists: () => false,
    }),
  });
}

beforeEach(() => {
  testDb = new Database(':memory:');
  applySchema(testDb);
});

describe('admin /processing', () => {
  it('403 for a non-admin', async () => {
    const app = authed(
      new Hono<AuthEnv>().route(
        '/',
        adminRoutes({ musicDir: '/music', processing: makeService() }),
      ),
      'user',
    );
    expect((await app.request('/processing')).status).toBe(403);
  });

  it('503 when the service is not wired', async () => {
    const app = authed(
      new Hono<AuthEnv>().route('/', adminRoutes({ musicDir: '/music' })),
      'admin',
    );
    expect((await app.request('/processing')).status).toBe(503);
  });

  it('returns settings + status', async () => {
    const app = authed(
      new Hono<AuthEnv>().route(
        '/',
        adminRoutes({ musicDir: '/music', processing: makeService() }),
      ),
      'admin',
    );
    const res = await app.request('/processing');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      settings: { enabled: boolean };
      status: { phase: string; availability: Record<string, unknown> };
    };
    expect(body.settings.enabled).toBe(true);
    expect(body.status.phase).toBeDefined();
    // bpm unavailable (no ffmpeg), genre unavailable (no Lidarr) in this fake ctx.
    expect(body.status.availability.bpm).not.toBe(true);
  });

  it('updates settings via PUT', async () => {
    const app = authed(
      new Hono<AuthEnv>().route(
        '/',
        adminRoutes({ musicDir: '/music', processing: makeService() }),
      ),
      'admin',
    );
    const res = await app.request('/processing', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false, window: { start: '01:00', end: '04:00' } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      settings: { enabled: boolean; window: { start: string } };
    };
    expect(body.settings.enabled).toBe(false);
    expect(body.settings.window.start).toBe('01:00');
  });

  it('rejects a malformed window', async () => {
    const app = authed(
      new Hono<AuthEnv>().route(
        '/',
        adminRoutes({ musicDir: '/music', processing: makeService() }),
      ),
      'admin',
    );
    const res = await app.request('/processing', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ window: { start: '25:00', end: '04:00' } }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a non-positive batchSize', async () => {
    const app = authed(
      new Hono<AuthEnv>().route(
        '/',
        adminRoutes({ musicDir: '/music', processing: makeService() }),
      ),
      'admin',
    );
    const res = await app.request('/processing', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batchSize: 0 }),
    });
    expect(res.status).toBe(400);
  });

  it('accepts run and stop', async () => {
    const app = authed(
      new Hono<AuthEnv>().route(
        '/',
        adminRoutes({ musicDir: '/music', processing: makeService() }),
      ),
      'admin',
    );
    expect((await app.request('/processing/run', { method: 'POST' })).status).toBe(200);
    expect((await app.request('/processing/stop', { method: 'POST' })).status).toBe(200);
  });
});
