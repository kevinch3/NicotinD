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
import type { StartResult } from '../services/maintenance/maintenance.service.js';

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
    const app = authed(
      new Hono<AuthEnv>().route('/', libraryRoutes('/music', { lidarr })),
      'admin',
    );
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

  /** A maintenance runner double recording what the route asked it to do. */
  function fakeMaintenance(outcome: StartResult = 'started') {
    const calls: Array<{ task: string; params: Record<string, string> }> = [];
    return {
      calls,
      start(task: string, q: URLSearchParams) {
        calls.push({ task, params: Object.fromEntries(q) });
        return outcome;
      },
      cancel: () => outcome === 'started',
      availability: () => ({ 'metadata-optimize': 'Lidarr is not configured' }) as never,
      getStatus: () => ({ phase: 'running', taskId: 'metadata-optimize', params: 'apply' }),
    };
  }

  const appWith = (m: unknown) =>
    authed(
      new Hono<AuthEnv>().route('/', adminRoutes({ musicDir: '/music', maintenance: m as never })),
      'admin',
    );

  it('503 when no maintenance runner is wired', async () => {
    const res = await appWith(null).request('/metadata-optimize', { method: 'POST' });
    expect(res.status).toBe(503);
  });

  it("503 with the task's own reason when it is unavailable (no Lidarr)", async () => {
    const res = await appWith(fakeMaintenance('unavailable')).request('/metadata-optimize', {
      method: 'POST',
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('Lidarr is not configured');
  });

  it('202s immediately instead of awaiting the pass', async () => {
    const m = fakeMaintenance();
    const res = await appWith(m).request('/metadata-optimize', { method: 'POST' });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: boolean; started: boolean };
    expect(body.ok).toBe(true);
    expect(body.started).toBe(true);
    expect(m.calls).toEqual([{ task: 'metadata-optimize', params: {} }]);
  });

  it('passes dryRun/all through to the task', async () => {
    const m = fakeMaintenance();
    await appWith(m).request('/metadata-optimize?all=1&dryRun=1', { method: 'POST' });
    expect(m.calls[0]!.params).toEqual({ all: '1', dryRun: '1' });
  });

  it('409s when a pass is already running', async () => {
    const res = await appWith(fakeMaintenance('busy')).request('/metadata-optimize', {
      method: 'POST',
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('MAINTENANCE_RUNNING');
  });

  it('records one audit row per pass', async () => {
    await appWith(fakeMaintenance()).request('/metadata-optimize', { method: 'POST' });
    const rows = testDb
      .query<{ action: string; target_id: string }, []>('SELECT action, target_id FROM audit_log')
      .all();
    expect(rows).toEqual([{ action: 'maintenance.start', target_id: 'metadata-optimize' }]);
  });

  it('403 for a non-admin', async () => {
    const app = authed(
      new Hono<AuthEnv>().route(
        '/',
        adminRoutes({ musicDir: '/music', maintenance: fakeMaintenance() as never }),
      ),
      'user',
    );
    const res = await app.request('/metadata-optimize', { method: 'POST' });
    expect(res.status).toBe(403);
  });
});

describe('maintenance cancel + status', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    applySchema(testDb);
  });

  it('cancel audits only when it actually stopped something', async () => {
    const idle = {
      start: () => 'started' as StartResult,
      cancel: () => false,
      availability: () => ({}) as never,
      getStatus: () => ({ phase: 'idle', taskId: null }),
    };
    const app = authed(
      new Hono<AuthEnv>().route(
        '/',
        adminRoutes({ musicDir: '/music', maintenance: idle as never }),
      ),
      'admin',
    );
    const res = await app.request('/maintenance/cancel', { method: 'POST' });
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
    expect(testDb.query('SELECT 1 FROM audit_log').all()).toHaveLength(0);
  });
});
