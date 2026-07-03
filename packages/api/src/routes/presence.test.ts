import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import { presenceRoutes } from './presence.js';
import { presenceService } from '../services/presence.js';

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
