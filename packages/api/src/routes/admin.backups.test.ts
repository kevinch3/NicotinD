/**
 * Route tests for the admin backup endpoints: admin gate, 503 without a
 * dataDir, list + trigger round-trip.
 */
import { describe, expect, it, beforeEach, afterAll, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const dataDir = mkdtempSync(join(tmpdir(), 'nicotind-backup-routes-'));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

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
  rmSync(join(dataDir, 'backups'), { recursive: true, force: true });
});

describe('admin backup routes', () => {
  it('rejects non-admins', async () => {
    const app = authed(adminRoutes({ musicDir: '/music', dataDir }), 'user');
    expect((await app.request('/backups')).status).toBe(403);
  });

  it('503s when no dataDir is wired', async () => {
    const app = authed(adminRoutes({ musicDir: '/music' }));
    expect((await app.request('/backups')).status).toBe(503);
    expect((await app.request('/backups', { method: 'POST' })).status).toBe(503);
  });

  it('POST creates a backup that GET then lists', async () => {
    const app = authed(adminRoutes({ musicDir: '/music', dataDir }));

    const created = await app.request('/backups', { method: 'POST' });
    expect(created.status).toBe(201);
    const info = await created.json();
    expect(info.files).toContain('nicotind.db');

    const list = await app.request('/backups');
    expect(list.status).toBe(200);
    const items = await list.json();
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe(info.name);
  });
});
