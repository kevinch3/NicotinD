/**
 * Route test for the presence merge in GET /api/admin/users: presence fields are
 * added per user, and users with no active sessions default to offline / zero.
 */
import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { JwtPayload } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { applySchema } from '../db.js';
import { adminRoutes } from './admin.js';
import { presenceService } from '../services/presence.js';

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

function authedAdmin(app: Hono<AuthEnv>): Hono<AuthEnv> {
  const wrap = new Hono<AuthEnv>();
  wrap.use('*', async (c, next) => {
    c.set('user', { sub: 'admin1', role: 'admin', iat: 0, exp: 0 } as JwtPayload);
    await next();
  });
  wrap.route('/', app);
  return wrap;
}

function seedUser(id: string, username: string, role = 'user') {
  testDb
    .query('INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, username, 'x', role, new Date().toISOString());
}

type EnrichedUser = {
  id: string;
  username: string;
  isConnected: boolean;
  amountOfDevices: number;
  amountOfSessions: number;
};

beforeEach(() => {
  testDb = new Database(':memory:');
  applySchema(testDb);
});

afterEach(() => {
  // Clean up any presence state seeded during a test so cases stay isolated.
  presenceService.removeSession('online1:phone:tab-1');
  presenceService.removeSession('online1:laptop:tab-2');
});

describe('admin /users presence merge', () => {
  it('merges presence for active users and defaults offline users to zero', async () => {
    seedUser('online1', 'alice');
    seedUser('offline1', 'bob');

    // alice: 2 devices, 2 sessions; bob: nothing.
    presenceService.heartbeat('online1', 'phone', 'tab-1');
    presenceService.heartbeat('online1', 'laptop', 'tab-2');

    const app = authedAdmin(
      new Hono<AuthEnv>().route('/', adminRoutes({ musicDir: '/music' })),
    );
    const res = await app.request('/users');
    expect(res.status).toBe(200);

    const users = (await res.json()) as EnrichedUser[];
    const alice = users.find((u) => u.id === 'online1')!;
    const bob = users.find((u) => u.id === 'offline1')!;

    expect(alice).toMatchObject({
      isConnected: true,
      amountOfDevices: 2,
      amountOfSessions: 2,
    });
    expect(bob).toMatchObject({
      isConnected: false,
      amountOfDevices: 0,
      amountOfSessions: 0,
    });
  });
});
