/**
 * Route tests for the per-user preferences door (issue #1299). Worth pinning:
 * the body is validated against the shared core schema (unknown keys and
 * out-of-range values are 400 with a stable code), a patch merges, and every
 * call is scoped to the caller with no user id in the path.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { AuthEnv } from '../middleware/auth.js';
import { applySchema } from '../db.js';

let testDb: Database = new Database(':memory:');
mock.module('../db.js', () => ({
  getDatabase: () => testDb,
  initDatabase: () => testDb,
  applySchema,
}));

const { userPreferencesRoutes } = await import('./user-preferences.js');

function appFor(userId: string): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { sub: userId, username: userId } as AuthEnv['Variables']['user']);
    await next();
  });
  app.route('/me', userPreferencesRoutes());
  return app;
}

function patch(app: Hono<AuthEnv>, body: unknown) {
  return app.request('/me/preferences', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  testDb = new Database(':memory:');
  applySchema(testDb);
  for (const id of ['u1', 'u2']) {
    testDb.run("INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'user')", [
      id,
      id,
    ]);
  }
});

describe('GET /me/preferences', () => {
  it('returns the all-null shape for a fresh user', async () => {
    const res = await appFor('u1').request('/me/preferences');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      homeView: null,
      theme: null,
      followSystemTheme: null,
      language: null,
      radioStrategy: null,
      welcomeDismissed: false,
      queueAcquired: null,
    });
  });
});

describe('PATCH /me/preferences', () => {
  it('stores a partial body and returns the merged preferences', async () => {
    const app = appFor('u1');
    const res = await patch(app, { theme: 'eink', homeView: 'shelves' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ theme: 'eink', homeView: 'shelves', language: null });

    const again = await patch(app, { language: 'es' });
    expect(await again.json()).toMatchObject({
      theme: 'eink',
      homeView: 'shelves',
      language: 'es',
    });
  });

  it('rejects an unknown key with 400 and a stable code', async () => {
    const res = await patch(appFor('u1'), { colour: 'red' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('VALIDATION_ERROR');
  });

  it('rejects an out-of-range value with 400', async () => {
    const res = await patch(appFor('u1'), { theme: 'neon' });
    expect(res.status).toBe(400);
  });

  it('rejects an empty body and a non-JSON body with 400', async () => {
    expect((await patch(appFor('u1'), {})).status).toBe(400);
    const res = await appFor('u1').request('/me/preferences', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('is scoped to the caller: one user cannot read another', async () => {
    await patch(appFor('u1'), { theme: 'oled' });
    const other = await appFor('u2').request('/me/preferences');
    expect(((await other.json()) as { theme: string | null }).theme).toBeNull();
  });
});
