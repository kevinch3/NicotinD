import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { AuthEnv } from '../middleware/auth.js';
import { applySchema } from '../db.js';
import { presenceRoutes } from './presence.js';
import { presenceService } from '../services/presence.js';
import { resetLastSeenThrottle } from '../services/user-last-seen.js';

let testDb: Database | null = null;

// The heartbeat now also stamps users.last_seen_at through getDatabase().
mock.module('../db.js', () => ({
  getDatabase: () => {
    if (!testDb) throw new Error('Database not initialized');
    return testDb;
  },
  applySchema,
}));

/** Mount the presence routes behind a middleware that injects a fake authed user. */
function makeApp(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { sub: userId } as AuthEnv['Variables']['user']);
    await next();
  });
  app.route('/', presenceRoutes());
  return app;
}

describe('presence routes', () => {
  it('records a heartbeat and returns 204', async () => {
    const userId = `route-user-${crypto.randomUUID()}`;
    const app = makeApp(userId);

    const res = await app.request('/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-a', tabId: 'tab-1' }),
    });

    expect(res.status).toBe(204);
    expect(presenceService.getUserPresence(userId)).toEqual({
      isConnected: true,
      amountOfDevices: 1,
      amountOfSessions: 1,
    });
    presenceService.removeSession(`${userId}:dev-a:tab-1`);
  });

  it('returns 400 when deviceId is missing', async () => {
    const app = makeApp(`route-user-${crypto.randomUUID()}`);
    const res = await app.request('/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tabId: 'tab-1' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when tabId is missing', async () => {
    const app = makeApp(`route-user-${crypto.randomUUID()}`);
    const res = await app.request('/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-a' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when the body is empty', async () => {
    const app = makeApp(`route-user-${crypto.randomUUID()}`);
    const res = await app.request('/heartbeat', { method: 'POST' });
    expect(res.status).toBe(400);
  });
});

describe('heartbeat → users.last_seen_at', () => {
  function beat(app: ReturnType<typeof makeApp>) {
    return app.request('/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-a', tabId: 'tab-1' }),
    });
  }

  function lastSeen(id: string): number | null {
    return (
      testDb!
        .query<{ last_seen_at: number | null }, [string]>(
          'SELECT last_seen_at FROM users WHERE id = ?',
        )
        .get(id)?.last_seen_at ?? null
    );
  }

  beforeEach(() => {
    resetLastSeenThrottle();
    testDb = new Database(':memory:');
    applySchema(testDb);
    testDb.run("INSERT INTO users (id, username, password_hash) VALUES ('u1', 'alice', 'x')");
  });

  it('stamps the persisted last-seen, then throttles the next beat', async () => {
    const app = makeApp('u1');
    expect(lastSeen('u1')).toBeNull();

    expect((await beat(app)).status).toBe(204);
    const first = lastSeen('u1');
    expect(first).toBeGreaterThan(0);

    // The beat fires once a minute per tab; only one write per window may land.
    expect((await beat(app)).status).toBe(204);
    expect(lastSeen('u1')).toBe(first);

    presenceService.removeSession('u1:dev-a:tab-1');
  });

  it('still returns 204 when the database is unavailable', async () => {
    // Telemetry must never be able to fail a heartbeat — this is the regression
    // guard for resolving getDatabase() outside touchLastSeen's catch.
    testDb = null;
    const app = makeApp('u1');
    expect((await beat(app)).status).toBe(204);
    presenceService.removeSession('u1:dev-a:tab-1');
  });
});
