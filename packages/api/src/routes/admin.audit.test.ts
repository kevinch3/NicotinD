/**
 * Route tests for the admin audit log: instrumented mutations write entries,
 * GET /audit lists them (admin-gated).
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
    c.set('user', { sub: 'admin1', username: 'boss', role, iat: 0, exp: 0 } as JwtPayload);
    await next();
  });
  wrap.route('/', app);
  return wrap;
}

beforeEach(() => {
  testDb = new Database(':memory:');
  applySchema(testDb);
  testDb.run(
    "INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u2', 'mate', 'x', 'user', '2020-01-01')",
  );
});

describe('admin audit log', () => {
  it('rejects non-admins on GET /audit', async () => {
    const app = authed(adminRoutes({ musicDir: '/m' }), 'user');
    expect((await app.request('/audit')).status).toBe(403);
  });

  it('user management mutations land in the audit log with the actor attached', async () => {
    const app = authed(adminRoutes({ musicDir: '/m' }));

    await app.request('/users/u2/role', {
      method: 'PUT',
      body: JSON.stringify({ role: 'refiner' }),
      headers: { 'content-type': 'application/json' },
    });
    await app.request('/users/u2', { method: 'DELETE' });

    const rows = await (await app.request('/audit')).json();
    expect(rows.map((r: { action: string }) => r.action)).toEqual(['user.delete', 'user.role']);
    expect(rows[1]).toMatchObject({
      userId: 'admin1',
      username: 'boss',
      targetKind: 'user',
      targetId: 'u2',
      detail: 'refiner',
    });
  });

  it('paginates via limit/offset', async () => {
    const app = authed(adminRoutes({ musicDir: '/m' }));
    for (const role of ['refiner', 'user', 'listener']) {
      await app.request('/users/u2/role', {
        method: 'PUT',
        body: JSON.stringify({ role }),
        headers: { 'content-type': 'application/json' },
      });
    }
    const page = await (await app.request('/audit?limit=2&offset=1')).json();
    expect(page).toHaveLength(2);
    expect(page.map((r: { detail: string }) => r.detail)).toEqual(['user', 'refiner']);
  });
});
