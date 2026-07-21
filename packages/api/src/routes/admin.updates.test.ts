/**
 * Route tests for GET /api/admin/update-check: admin gate, empty state, and
 * update-available computation against a seeded cached check.
 */
import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { JwtPayload } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { applySchema } from '../db.js';
import { adminRoutes } from './admin.js';
import { checkForUpdateNow, recordBootVersion } from '../services/update-check.js';

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

beforeEach(() => {
  testDb = new Database(':memory:');
  applySchema(testDb);
});

describe('GET /update-check', () => {
  it('rejects non-admins', async () => {
    const app = authed(adminRoutes({ musicDir: '/m', version: '0.1.230' }), 'user');
    expect((await app.request('/update-check')).status).toBe(403);
  });

  it('reports no update when nothing is cached yet', async () => {
    const app = authed(adminRoutes({ musicDir: '/m', version: '0.1.230' }));
    const body = await (await app.request('/update-check')).json();
    expect(body.currentVersion).toBe('0.1.230');
    expect(body.latestVersion).toBeNull();
    expect(body.updateAvailable).toBe(false);
    expect(body.checkedAt).toBeNull();
  });

  it('computes updateAvailable from the cached check + lists version history', async () => {
    recordBootVersion(testDb, '0.1.229', 100);
    recordBootVersion(testDb, '0.1.230', 200);
    await checkForUpdateNow(testDb, {
      now: 1000,
      fetchImpl: async () =>
        new Response(JSON.stringify({ tag_name: 'v0.1.231', html_url: 'https://x/rel' }), {
          status: 200,
        }),
    });

    const app = authed(adminRoutes({ musicDir: '/m', version: '0.1.230' }));
    const body = await (await app.request('/update-check')).json();
    expect(body.latestVersion).toBe('0.1.231');
    expect(body.updateAvailable).toBe(true);
    expect(body.releaseUrl).toBe('https://x/rel');
    expect(body.versionHistory.map((r: { version: string }) => r.version)).toEqual([
      '0.1.230',
      '0.1.229',
    ]);
  });

  it('reports up-to-date when the cached latest matches the running version', async () => {
    await checkForUpdateNow(testDb, {
      now: 1000,
      fetchImpl: async () =>
        new Response(JSON.stringify({ tag_name: 'v0.1.230' }), { status: 200 }),
    });
    const app = authed(adminRoutes({ musicDir: '/m', version: '0.1.230' }));
    const body = await (await app.request('/update-check')).json();
    expect(body.updateAvailable).toBe(false);
  });
});
