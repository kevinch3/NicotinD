/**
 * Route tests for the ML vocal-separation opt-in (issue #603): admin-gated,
 * the sidecar URL is a structural floor, and every flip is audited — the
 * `admin.registration.test.ts` shape.
 */
import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { JwtPayload } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { applySchema } from '../db.js';
import { adminRoutes } from './admin.js';
import { VocalSeparationToggle } from '../services/vocal-separation-toggle.js';

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
    c.set('user', { sub: 'admin1', username: 'boss', role, iat: 0, exp: 0 } as JwtPayload);
    await next();
  });
  wrap.route('/', app);
  return wrap;
}

function app(configured: boolean, role: 'admin' | 'user' = 'admin') {
  return authed(
    adminRoutes({ musicDir: '/m', vocalSeparation: new VocalSeparationToggle(testDb, configured) }),
    role,
  );
}

beforeEach(() => {
  testDb = new Database(':memory:');
  applySchema(testDb);
});

describe('GET /vocal-separation', () => {
  it('rejects non-admins', async () => {
    expect((await app(true, 'user').request('/vocal-separation')).status).toBe(403);
  });

  it('is off by default and configurable when a sidecar URL is set', async () => {
    const res = await app(true).request('/vocal-separation');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, configurable: true });
  });

  it('reports not configurable when no sidecar URL is set', async () => {
    expect(await (await app(false).request('/vocal-separation')).json()).toEqual({
      enabled: false,
      configurable: false,
    });
  });

  it('503s when the toggle is not wired at all', async () => {
    const bare = authed(adminRoutes({ musicDir: '/m' }));
    expect((await bare.request('/vocal-separation')).status).toBe(503);
  });
});

describe('PUT /vocal-separation', () => {
  const put = (a: Hono<AuthEnv>, body: unknown) =>
    a.request('/vocal-separation', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('turns separation on, persists it, and audits the flip', async () => {
    const a = app(true);
    const res = await put(a, { enabled: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, configurable: true });
    expect(await (await a.request('/vocal-separation')).json()).toEqual({
      enabled: true,
      configurable: true,
    });
    const audit = testDb
      .query<{ action: string; detail: string }, []>('SELECT action, detail FROM audit_log')
      .all();
    expect(audit.map((r) => r.action)).toEqual(['vocal-separation.toggle']);
    expect(audit[0].detail).toContain('effective=true');
  });

  it('cannot lift the structural floor: with no sidecar the effective value stays off', async () => {
    const res = await put(app(false), { enabled: true });
    expect(await res.json()).toEqual({ enabled: false, configurable: false });
  });

  it('rejects a non-boolean body', async () => {
    expect((await put(app(true), { enabled: 'yes' })).status).toBe(400);
  });
});
