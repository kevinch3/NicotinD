/**
 * Route test for PUT /api/admin/users/:id/role — the role enum was widened from
 * {admin,user} to the full ladder {listener,user,refiner,admin}.
 */
import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { JwtPayload, Role } from '@nicotind/core';
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

function authedAdmin(): Hono<AuthEnv> {
  const wrap = new Hono<AuthEnv>();
  wrap.use('*', async (c, next) => {
    c.set('user', { sub: 'admin1', role: 'admin', iat: 0, exp: 0 } as JwtPayload);
    await next();
  });
  wrap.route('/', new Hono<AuthEnv>().route('/', adminRoutes({ musicDir: '/music' })));
  return wrap;
}

function seedUser(id: string, username: string, role = 'user') {
  testDb
    .query('INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, username, 'x', role, new Date().toISOString());
}

function roleOf(id: string): string | undefined {
  return testDb.query<{ role: string }, [string]>('SELECT role FROM users WHERE id = ?').get(id)
    ?.role;
}

async function setRole(app: Hono<AuthEnv>, id: string, role: string) {
  return app.request(`/users/${id}/role`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
}

beforeEach(() => {
  testDb = new Database(':memory:');
  applySchema(testDb);
});

describe('PUT /users/:id/role', () => {
  it('accepts every role on the ladder', async () => {
    const app = authedAdmin();
    for (const role of ['listener', 'user', 'refiner', 'admin'] as Role[]) {
      seedUser(`u-${role}`, `u-${role}`);
      const res = await setRole(app, `u-${role}`, role);
      expect(res.status).toBe(200);
      expect(roleOf(`u-${role}`)).toBe(role);
    }
  });

  it('rejects an unknown role with 400', async () => {
    seedUser('u1', 'alice');
    const res = await setRole(authedAdmin(), 'u1', 'superuser');
    expect(res.status).toBe(400);
    expect(roleOf('u1')).toBe('user');
  });

  it('404s for an unknown user', async () => {
    const res = await setRole(authedAdmin(), 'ghost', 'refiner');
    expect(res.status).toBe(404);
  });
});
