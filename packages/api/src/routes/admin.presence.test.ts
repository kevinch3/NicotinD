/**
 * Route test for the presence merge in GET /api/admin/users: presence fields are
 * added per user, users with no active sessions default to offline / zero, and the
 * list comes back in activity order with the persisted `last_seen_at` attached.
 */
import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { JwtPayload } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { applySchema } from '../db.js';
import { adminRoutes, compareUsersByActivity } from './admin.js';
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

function seedUser(
  id: string,
  username: string,
  role = 'user',
  opts: { createdAt?: string; lastSeenAt?: number | null } = {},
) {
  testDb
    .query(
      'INSERT INTO users (id, username, password_hash, role, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(
      id,
      username,
      'x',
      role,
      opts.createdAt ?? new Date().toISOString(),
      opts.lastSeenAt ?? null,
    );
}

type EnrichedUser = {
  id: string;
  username: string;
  last_seen_at: number | null;
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

    const app = authedAdmin(new Hono<AuthEnv>().route('/', adminRoutes({ musicDir: '/music' })));
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

  it('ships the persisted last_seen_at alongside the ephemeral presence fields', async () => {
    seedUser('seen1', 'alice', 'user', { lastSeenAt: 1_700_000_000_000 });
    seedUser('never1', 'bob');

    const app = authedAdmin(new Hono<AuthEnv>().route('/', adminRoutes({ musicDir: '/music' })));
    const users = (await (await app.request('/users')).json()) as EnrichedUser[];

    expect(users.find((u) => u.id === 'seen1')!.last_seen_at).toBe(1_700_000_000_000);
    // Never connected reads as null, not as a fabricated created_at.
    expect(users.find((u) => u.id === 'never1')!.last_seen_at).toBeNull();
  });

  it('orders the list by activity: online first, then most recently seen, never last', async () => {
    // Deliberately seeded so created_at ASC (the old order) would give the
    // opposite answer to the one we want.
    seedUser('never1', 'zoe', 'user', { createdAt: '2020-01-01 00:00:00' });
    seedUser('seen-old', 'yara', 'user', {
      createdAt: '2021-01-01 00:00:00',
      lastSeenAt: 1_000,
    });
    seedUser('seen-recent', 'xena', 'user', {
      createdAt: '2022-01-01 00:00:00',
      lastSeenAt: 9_000,
    });
    // Online, but the least recently *stamped* — presence must still win.
    seedUser('online1', 'wendy', 'user', {
      createdAt: '2023-01-01 00:00:00',
      lastSeenAt: null,
    });
    presenceService.heartbeat('online1', 'phone', 'tab-1');

    const app = authedAdmin(new Hono<AuthEnv>().route('/', adminRoutes({ musicDir: '/music' })));
    const users = (await (await app.request('/users')).json()) as EnrichedUser[];

    expect(users.map((u) => u.id)).toEqual(['online1', 'seen-recent', 'seen-old', 'never1']);
  });

  it('creates a user with a SQLite-shaped created_at and a null last_seen_at', async () => {
    const app = authedAdmin(new Hono<AuthEnv>().route('/', adminRoutes({ musicDir: '/music' })));
    const res = await app.request('/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'newbie', password: 'pass' }),
    });
    expect(res.status).toBe(201);

    const body = (await res.json()) as EnrichedUser & { created_at: string };
    expect(body.last_seen_at).toBeNull();
    // "YYYY-MM-DD HH:MM:SS" — the web appends its own "Z", so an ISO string here
    // would render as Invalid Date in the Joined line.
    expect(body.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(Number.isNaN(new Date(body.created_at + 'Z').getTime())).toBe(false);
  });
});

describe('compareUsersByActivity', () => {
  const row = (over: Partial<Parameters<typeof compareUsersByActivity>[0]>) => ({
    isConnected: false,
    last_seen_at: null,
    created_at: '2020-01-01 00:00:00',
    ...over,
  });

  it('puts a connected user ahead of a more recently seen offline one', () => {
    const online = row({ isConnected: true, last_seen_at: null });
    const offline = row({ last_seen_at: Date.now() });
    expect(compareUsersByActivity(online, offline)).toBeLessThan(0);
    expect(compareUsersByActivity(offline, online)).toBeGreaterThan(0);
  });

  it('sorts a never-seen user last rather than first', () => {
    // NULL is "unknown", not "infinitely long ago" — the trap a raw numeric
    // comparison with a 0 fallback would fall into.
    const never = row({ last_seen_at: null });
    const ancient = row({ last_seen_at: 1 });
    expect(compareUsersByActivity(never, ancient)).toBeGreaterThan(0);
  });

  it('falls through to created_at when activity is identical', () => {
    const older = row({ created_at: '2020-01-01 00:00:00' });
    const newer = row({ created_at: '2021-01-01 00:00:00' });
    expect(compareUsersByActivity(older, newer)).toBeLessThan(0);
    expect(compareUsersByActivity(older, older)).toBe(0);
  });
});
