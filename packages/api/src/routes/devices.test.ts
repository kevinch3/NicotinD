import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Hono } from 'hono';
import * as jose from 'jose';
import { devicesRoutes, generatePairingCode, createFixedWindowLimiter } from './devices.js';
import { authMiddleware, signJwt } from '../middleware/auth.js';
import type { AuthEnv } from '../middleware/auth.js';
import { applySchema } from '../db.js';

const testDb = new Database(':memory:');
applySchema(testDb);
testDb.run(
  "INSERT INTO users (id, username, password_hash, role) VALUES ('u1', 'alice', 'hash', 'admin')",
);

mock.module('../db.js', () => ({ getDatabase: () => testDb, applySchema }));

const SECRET = 'test-secret-at-least-32-chars-long-xx';

beforeEach(() => {
  testDb.run('DELETE FROM pairing_tokens');
  testDb.run('DELETE FROM paired_devices');
});

function buildApp(now?: () => number) {
  const app = new Hono<AuthEnv>();
  const auth = authMiddleware(SECRET);
  app.route(
    '/api/devices',
    devicesRoutes({ jwtSecret: SECRET, jwtExpiresIn: '30d', auth, remoteAccess: null, now }),
  );
  return app;
}

async function userToken(deviceId?: string) {
  return signJwt({ sub: 'u1', username: 'alice', role: 'admin', deviceId }, SECRET);
}

async function mint(app: Hono<AuthEnv>) {
  const res = await app.request('http://public.example/api/devices/pair', {
    method: 'POST',
    headers: { Authorization: `Bearer ${await userToken()}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    token: string;
    code: string;
    expiresAt: number;
    urls: string[];
  };
}

describe('POST /api/devices/pair', () => {
  it('requires auth', async () => {
    const res = await buildApp().request('/api/devices/pair', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('mints a token + 6-char code and includes the non-loopback request origin', async () => {
    const minted = await mint(buildApp());
    expect(minted.token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url
    expect(minted.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(minted.urls).toEqual(['http://public.example']);
    expect(minted.expiresAt).toBeGreaterThan(Date.now());
  });

  it('filters a loopback request origin out of the QR candidates', async () => {
    const app = buildApp();
    const res = await app.request('http://127.0.0.1:8484/api/devices/pair', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await userToken()}` },
    });
    const body = (await res.json()) as { urls: string[] };
    expect(body.urls).toEqual([]);
  });

  it('reminting invalidates the previous unclaimed token', async () => {
    const app = buildApp();
    const first = await mint(app);
    await mint(app);
    const res = await app.request('/api/devices/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: first.token }),
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/devices/claim', () => {
  it('exchanges a token for a device-bound JWT and registers the device', async () => {
    const app = buildApp();
    const minted = await mint(app);
    const res = await app.request('/api/devices/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: minted.token, deviceName: 'My phone', platform: 'android' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; user: { username: string } };
    expect(body.user.username).toBe('alice');

    const payload = jose.decodeJwt(body.token) as { sub: string; deviceId?: string };
    expect(payload.sub).toBe('u1');
    expect(payload.deviceId).toBeString();

    const device = testDb
      .query<{ id: string; name: string; platform: string }, [string]>(
        'SELECT id, name, platform FROM paired_devices WHERE id = ?',
      )
      .get(payload.deviceId!);
    expect(device?.name).toBe('My phone');
    expect(device?.platform).toBe('android');
  });

  it('claims by code (case-insensitive)', async () => {
    const app = buildApp();
    const minted = await mint(app);
    const res = await app.request('/api/devices/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: minted.code.toLowerCase(), platform: 'ios' }),
    });
    expect(res.status).toBe(200);
  });

  it('is single-use: a second claim of the same token returns 410', async () => {
    const app = buildApp();
    const minted = await mint(app);
    const claim = () =>
      app.request('/api/devices/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: minted.token }),
      });
    expect((await claim()).status).toBe(200);
    expect((await claim()).status).toBe(410);
  });

  it('returns 410 for an expired token', async () => {
    let t = Date.now();
    const app = buildApp(() => t);
    const minted = await mint(app);
    t += 6 * 60 * 1000; // past the 5-minute TTL
    const res = await app.request('/api/devices/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: minted.token }),
    });
    expect(res.status).toBe(410);
  });

  it('returns 404 for an unknown token and 400 for an empty body', async () => {
    const app = buildApp();
    const unknown = await app.request('/api/devices/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'nope' }),
    });
    expect(unknown.status).toBe(404);
    const empty = await app.request('/api/devices/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);
  });

  it('rate-limits repeated failed guesses with 429', async () => {
    const app = buildApp();
    let last = 0;
    // The failure budget is 10 per window; the 11th bad guess trips it.
    for (let i = 0; i < 11; i++) {
      const res = await app.request('/api/devices/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'XXXXXX' }),
      });
      last = res.status;
    }
    expect(last).toBe(429);
  });

  it('refuses a disabled account (403)', async () => {
    const app = buildApp();
    const minted = await mint(app);
    testDb.run("UPDATE users SET status = 'disabled' WHERE id = 'u1'");
    try {
      const res = await app.request('/api/devices/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: minted.token }),
      });
      expect(res.status).toBe(403);
    } finally {
      testDb.run("UPDATE users SET status = 'active' WHERE id = 'u1'");
    }
  });
});

describe('GET /api/devices + DELETE /api/devices/:id', () => {
  it('lists own devices with a current flag and revokes by delete', async () => {
    const app = buildApp();
    const minted = await mint(app);
    const claimRes = await app.request('/api/devices/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: minted.token, platform: 'android' }),
    });
    const { token: deviceJwt } = (await claimRes.json()) as { token: string };
    const { deviceId } = jose.decodeJwt(deviceJwt) as { deviceId: string };

    const list = await app.request('/api/devices', {
      headers: { Authorization: `Bearer ${deviceJwt}` },
    });
    const listBody = (await list.json()) as {
      devices: Array<{ id: string; current: boolean }>;
    };
    expect(listBody.devices).toHaveLength(1);
    expect(listBody.devices[0].id).toBe(deviceId);
    expect(listBody.devices[0].current).toBeTrue();

    const del = await app.request(`/api/devices/${deviceId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${await userToken()}` },
    });
    expect(del.status).toBe(200);
    expect(
      testDb.query('SELECT id FROM paired_devices WHERE id = ?').get(deviceId),
    ).toBeNull();
  });

  it('cannot revoke another user\'s device (404)', async () => {
    testDb.run(
      "INSERT INTO users (id, username, password_hash, role) VALUES ('u2', 'bob', 'hash', 'user')",
    );
    testDb.run(
      "INSERT INTO paired_devices (id, user_id, name, platform, created_at) VALUES ('d-bob', 'u2', 'Bob phone', 'ios', 1)",
    );
    try {
      const res = await buildApp().request('/api/devices/d-bob', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${await userToken()}` },
      });
      expect(res.status).toBe(404);
      expect(testDb.query("SELECT id FROM paired_devices WHERE id = 'd-bob'").get()).not.toBeNull();
    } finally {
      testDb.run("DELETE FROM paired_devices WHERE id = 'd-bob'");
      testDb.run("DELETE FROM users WHERE id = 'u2'");
    }
  });
});

describe('generatePairingCode', () => {
  it('never emits ambiguous characters', () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePairingCode()).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    }
  });
});

describe('createFixedWindowLimiter', () => {
  it('allows up to the limit per window and resets on the next window', () => {
    let t = 0;
    const limiter = createFixedWindowLimiter(2, 1000, () => t);
    expect(limiter.hit()).toBeTrue();
    expect(limiter.hit()).toBeTrue();
    expect(limiter.hit()).toBeFalse();
    t = 1000;
    expect(limiter.hit()).toBeTrue();
  });
});
