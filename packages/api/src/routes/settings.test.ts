import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { settingsRoutes } from './settings.js';
import { authMiddleware, signJwt } from '../middleware/auth.js';
import type { AuthEnv } from '../middleware/auth.js';
import { applySchema } from '../db.js';

const testDb = new Database(':memory:');
applySchema(testDb);
testDb.run(
  "INSERT INTO users (id, username, password_hash, role) VALUES ('admin1', 'admin', 'hash', 'admin')",
);
testDb.run(
  "INSERT INTO users (id, username, password_hash, role) VALUES ('user1', 'alice', 'hash', 'user')",
);

mock.module('../db.js', () => ({ getDatabase: () => testDb, applySchema }));

const SECRET = 'test-secret';

async function adminToken() {
  return signJwt({ sub: 'admin1', username: 'admin', role: 'admin' }, SECRET);
}
async function userToken() {
  return signJwt({ sub: 'user1', username: 'alice', role: 'user' }, SECRET);
}

function makeSlskdMock() {
  return {
    server: {
      getState: mock(() =>
        Promise.resolve({ isConnected: true, username: 'u', state: 'Connected' }),
      ),
      disconnect: mock(() => Promise.resolve()),
      connect: mock(() => Promise.resolve()),
    },
    shares: {
      list: mock(() => Promise.resolve([{ path: '/data/music' }])),
      add: mock(() => Promise.resolve()),
      remove: mock(() => Promise.resolve()),
      rescan: mock(() => Promise.resolve()),
    },
  };
}

function buildApp(
  slskd: ReturnType<typeof makeSlskdMock> | null,
  overrides: { dataDir?: string; soulseek?: { username: string; password: string } } = {},
) {
  const app = new Hono<AuthEnv>();
  const auth = authMiddleware(SECRET);
  const config = {
    soulseek: overrides.soulseek ?? { username: 'u', password: 'p' },
    dataDir: overrides.dataDir ?? '/tmp/nicotind-test',
    mode: 'external',
  } as unknown as Parameters<typeof settingsRoutes>[0];
  const routes = settingsRoutes(
    config,
    { current: slskd } as unknown as Parameters<typeof settingsRoutes>[1],
    {} as unknown as Parameters<typeof settingsRoutes>[2],
    {
      hasService: () => false,
      updateConfig: () => {},
      restartService: async () => {},
    } as unknown as Parameters<typeof settingsRoutes>[3],
    { current: null } as unknown as Parameters<typeof settingsRoutes>[4],
  );
  app.use('*', auth);
  app.route('/', routes);
  return app;
}

describe('GET /soulseek', () => {
  it('returns 200 with empty config (not 500) when secrets.json is absent', async () => {
    // Regression: a fresh data dir has no secrets.json. readSecrets used to
    // ENOENT-throw → 500 on every admin Settings load. Surfaced by the
    // remote-playback e2e flow (target opts in via the Settings page).
    const missingDir = join(tmpdir(), `nicotind-no-secrets-${Date.now()}`);
    expect(existsSync(join(missingDir, 'secrets.json'))).toBe(false);

    const app = buildApp(null, { dataDir: missingDir, soulseek: { username: '', password: '' } });
    const token = await adminToken();
    const res = await app.request('/soulseek', {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as { username: string; configured: boolean };
    expect(data.configured).toBe(false);
    expect(data.username).toBe('');
  });
});

describe('POST /soulseek/toggle', () => {
  let slskdMock: ReturnType<typeof makeSlskdMock>;

  beforeEach(() => {
    slskdMock = makeSlskdMock();
  });

  it('disconnects when currently connected', async () => {
    const app = buildApp(slskdMock);
    const token = await adminToken();
    const res = await app.request('/soulseek/toggle', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.connected).toBe(false);
    expect(slskdMock.server.disconnect).toHaveBeenCalled();
  });

  it('connects when currently disconnected', async () => {
    slskdMock.server.getState = mock(() =>
      Promise.resolve({ isConnected: false, username: '', state: 'Disconnected' }),
    );
    const app = buildApp(slskdMock);
    const token = await adminToken();
    const res = await app.request('/soulseek/toggle', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.connected).toBe(true);
    expect(slskdMock.server.connect).toHaveBeenCalled();
  });

  it('returns 403 for non-admin', async () => {
    const app = buildApp(slskdMock);
    const token = await userToken();
    const res = await app.request('/soulseek/toggle', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it('returns 503 when slskdRef is null', async () => {
    const app = buildApp(null);
    const token = await adminToken();
    const res = await app.request('/soulseek/toggle', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(503);
  });
});

describe('GET /shares', () => {
  let slskdMock: ReturnType<typeof makeSlskdMock>;

  beforeEach(() => {
    slskdMock = makeSlskdMock();
    slskdMock.shares.list = mock(() =>
      Promise.resolve([{ path: '/data/music' }, { path: '/data/other' }]),
    );
  });

  it('returns list of share directories for admin', async () => {
    const app = buildApp(slskdMock);
    const token = await adminToken();
    const res = await app.request('/shares', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.directories).toEqual(['/data/music', '/data/other']);
  });

  it('returns 403 for non-admin', async () => {
    const app = buildApp(slskdMock);
    const token = await userToken();
    const res = await app.request('/shares', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it('returns 503 when slskdRef is null', async () => {
    const app = buildApp(null);
    const token = await adminToken();
    const res = await app.request('/shares', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(503);
  });
});

describe('POST /shares', () => {
  let slskdMock: ReturnType<typeof makeSlskdMock>;

  beforeEach(() => {
    slskdMock = makeSlskdMock();
    slskdMock.shares.list = mock(() => Promise.resolve([]));
  });

  it('calls shares.add with the given path', async () => {
    const app = buildApp(slskdMock);
    const token = await adminToken();
    const res = await app.request('/shares', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/data/new-folder' }),
    });
    expect(res.status).toBe(200);
    expect(slskdMock.shares.add).toHaveBeenCalledWith('/data/new-folder');
  });

  it('returns 400 for missing path', async () => {
    const app = buildApp(slskdMock);
    const token = await adminToken();
    const res = await app.request('/shares', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /shares/:path', () => {
  let slskdMock: ReturnType<typeof makeSlskdMock>;

  beforeEach(() => {
    slskdMock = makeSlskdMock();
    slskdMock.shares.list = mock(() => Promise.resolve([]));
  });

  it('calls shares.remove with decoded path', async () => {
    const app = buildApp(slskdMock);
    const token = await adminToken();
    const encodedPath = encodeURIComponent('/data/music');
    const res = await app.request(`/shares/${encodedPath}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(slskdMock.shares.remove).toHaveBeenCalledWith('/data/music');
  });
});

describe('POST /shares/rescan', () => {
  let slskdMock: ReturnType<typeof makeSlskdMock>;

  beforeEach(() => {
    slskdMock = makeSlskdMock();
    slskdMock.shares.list = mock(() => Promise.resolve([]));
  });

  it('calls shares.rescan', async () => {
    const app = buildApp(slskdMock);
    const token = await adminToken();
    const res = await app.request('/shares/rescan', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(slskdMock.shares.rescan).toHaveBeenCalled();
  });

  it('returns 403 for non-admin', async () => {
    const app = buildApp(slskdMock);
    const token = await userToken();
    const res = await app.request('/shares/rescan', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });
});
