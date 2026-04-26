import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Hono } from 'hono';
import { settingsRoutes } from './settings.js';
import { authMiddleware, signJwt } from '../middleware/auth.js';

const testDb = new Database(':memory:');
testDb.run(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
testDb.run("INSERT INTO users VALUES ('admin1', 'admin', 'hash', 'admin', 'active', datetime('now'))");
testDb.run("INSERT INTO users VALUES ('user1', 'alice', 'hash', 'user', 'active', datetime('now'))");

mock.module('../db.js', () => ({ getDatabase: () => testDb }));

const SECRET = 'test-secret';

async function adminToken() {
  return signJwt({ sub: 'admin1', username: 'admin', role: 'admin' }, SECRET);
}
async function userToken() {
  return signJwt({ sub: 'user1', username: 'alice', role: 'user' }, SECRET);
}

function buildApp(slskd: any) {
  const app = new Hono<any>();
  const auth = authMiddleware(SECRET);
  const config = { soulseek: { username: 'u', password: 'p' }, dataDir: '/tmp/nicotind-test', mode: 'external' } as any;
  const routes = settingsRoutes(
    config,
    { current: slskd },
    {} as any,
    { hasService: () => false, updateConfig: () => {}, restartService: async () => {} } as any,
    { current: null } as any,
  );
  app.use('*', auth);
  app.route('/', routes);
  return app;
}

describe('POST /soulseek/toggle', () => {
  let slskdMock: any;

  beforeEach(() => {
    slskdMock = {
      server: {
        getState: mock(() => Promise.resolve({ isConnected: true, username: 'u', state: 'Connected' })),
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
  let slskdMock: any;

  beforeEach(() => {
    slskdMock = {
      server: {
        getState: mock(() => Promise.resolve({ isConnected: true, username: 'u', state: 'Connected' })),
        disconnect: mock(() => Promise.resolve()),
        connect: mock(() => Promise.resolve()),
      },
      shares: {
        list: mock(() => Promise.resolve([{ path: '/data/music' }, { path: '/data/other' }])),
        add: mock(() => Promise.resolve()),
        remove: mock(() => Promise.resolve()),
        rescan: mock(() => Promise.resolve()),
      },
    };
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
  let slskdMock: any;

  beforeEach(() => {
    slskdMock = {
      server: {
        getState: mock(() => Promise.resolve({ isConnected: true, username: 'u', state: 'Connected' })),
        disconnect: mock(() => Promise.resolve()),
        connect: mock(() => Promise.resolve()),
      },
      shares: {
        list: mock(() => Promise.resolve([])),
        add: mock(() => Promise.resolve()),
        remove: mock(() => Promise.resolve()),
        rescan: mock(() => Promise.resolve()),
      },
    };
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
  let slskdMock: any;

  beforeEach(() => {
    slskdMock = {
      server: {
        getState: mock(() => Promise.resolve({ isConnected: true, username: 'u', state: 'Connected' })),
        disconnect: mock(() => Promise.resolve()),
        connect: mock(() => Promise.resolve()),
      },
      shares: {
        list: mock(() => Promise.resolve([])),
        add: mock(() => Promise.resolve()),
        remove: mock(() => Promise.resolve()),
        rescan: mock(() => Promise.resolve()),
      },
    };
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
  let slskdMock: any;

  beforeEach(() => {
    slskdMock = {
      server: {
        getState: mock(() => Promise.resolve({ isConnected: true, username: 'u', state: 'Connected' })),
        disconnect: mock(() => Promise.resolve()),
        connect: mock(() => Promise.resolve()),
      },
      shares: {
        list: mock(() => Promise.resolve([])),
        add: mock(() => Promise.resolve()),
        remove: mock(() => Promise.resolve()),
        rescan: mock(() => Promise.resolve()),
      },
    };
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
