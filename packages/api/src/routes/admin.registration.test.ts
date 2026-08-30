/**
 * Route tests for the public-signup switch (issue #824): admin-gated, honours
 * the environment as authoritative, and audits every flip.
 */
import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { JwtPayload } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { applySchema } from '../db.js';
import { adminRoutes } from './admin.js';
import { RegistrationToggle } from '../services/registration-toggle.js';

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

/** `envValue: undefined` = the operator left the decision to the admin UI. */
function app(
  envValue: boolean | undefined,
  configDefault = false,
  role: 'admin' | 'user' = 'admin',
) {
  return authed(
    adminRoutes({
      musicDir: '/m',
      registration: new RegistrationToggle(testDb, envValue, configDefault),
    }),
    role,
  );
}

beforeEach(() => {
  testDb = new Database(':memory:');
  applySchema(testDb);
});

describe('GET /registration', () => {
  it('rejects non-admins', async () => {
    expect((await app(undefined, false, 'user').request('/registration')).status).toBe(403);
  });

  it('503s when the toggle is not wired', async () => {
    const bare = authed(adminRoutes({ musicDir: '/m' }));
    expect((await bare.request('/registration')).status).toBe(503);
  });

  it('reports the config default as configurable when the env is unset', async () => {
    const res = await app(undefined, false).request('/registration');

    expect(await res.json()).toEqual({ enabled: false, configurable: true });
  });

  it('reports not-configurable when the env pins the value', async () => {
    const res = await app(true, false).request('/registration');

    expect(await res.json()).toEqual({ enabled: true, configurable: false });
  });
});

describe('PUT /registration', () => {
  const put = (a: Hono<AuthEnv>, body: unknown) =>
    a.request('/registration', {
      method: 'PUT',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });

  it('rejects a non-boolean payload rather than coercing it', async () => {
    expect((await put(app(undefined), { enabled: 'yes' })).status).toBe(400);
    expect((await put(app(undefined), {})).status).toBe(400);
  });

  it('opens signup and persists the choice', async () => {
    const res = await put(app(undefined), { enabled: true });

    expect(await res.json()).toEqual({ enabled: true, configurable: true });
    // Survives a fresh toggle over the same DB, i.e. it really was written.
    expect(new RegistrationToggle(testDb, undefined, false).enabled()).toBe(true);
  });

  it('returns the effective value, not the requested one, when env pins it', async () => {
    const res = await put(app(false, true), { enabled: true });

    expect(await res.json()).toEqual({ enabled: false, configurable: false });
  });

  it('audits the flip with both the request and the effective result', async () => {
    await put(app(undefined), { enabled: true });

    const row = testDb
      .query<{ action: string; detail: string }, []>(
        'SELECT action, detail FROM audit_log ORDER BY rowid DESC LIMIT 1',
      )
      .get();
    expect(row?.action).toBe('registration.toggle');
    expect(row?.detail).toBe('requested=true effective=true');
  });
});
