import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Hono } from 'hono';
import { playlistRoutes } from './playlists.js';
import { authMiddleware, signJwt } from '../middleware/auth.js';
import type { AuthEnv } from '../middleware/auth.js';

// ── in-memory DB ──────────────────────────────────────────────────────────────

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
testDb.run(`
  CREATE TABLE playlist_visibility (
    playlist_id TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    visibility  TEXT NOT NULL DEFAULT 'personal'
                     CHECK (visibility IN ('personal', 'global'))
  )
`);
testDb.run("INSERT INTO users VALUES ('u1', 'alice', 'hash', 'user', 'active', datetime('now'))");
testDb.run("INSERT INTO users VALUES ('u2', 'bob',   'hash', 'user', 'active', datetime('now'))");
testDb.run("INSERT INTO users VALUES ('a1', 'admin', 'hash', 'admin','active', datetime('now'))");

mock.module('../db.js', () => ({ getDatabase: () => testDb }));

// ── helpers ───────────────────────────────────────────────────────────────────

const SECRET = 'test-secret';

function token(sub: string, role: 'user' | 'admin' = 'user') {
  return signJwt({ sub, username: sub, role }, SECRET);
}

type PlaylistRecord = { id: string; name: string; songCount: number; duration: number; owner: string; public: boolean; created: string; changed: string };

function makeNavidrome(overrides: Partial<{
  list: () => Promise<PlaylistRecord[]>;
  get: (id: string) => Promise<PlaylistRecord>;
  create: (name: string, songIds?: string[]) => Promise<PlaylistRecord>;
  update: (id: string, updates: { songIdsToAdd?: string[] }) => Promise<void>;
  delete: (id: string) => Promise<void>;
}> = {}) {
  return {
    playlists: {
      list:   mock(overrides.list   ?? (async () => [])),
      get:    mock(overrides.get    ?? (async (id: string) => ({ id, name: 'Test', songCount: 0, duration: 0, owner: 'admin', public: false, created: '', changed: '' }))),
      create: mock(overrides.create ?? (async (name: string) => ({ id: 'pl-new', name, songCount: 0, duration: 0, owner: 'admin', public: false, created: '', changed: '' }))),
      update: mock(overrides.update ?? (async () => {})),
      delete: mock(overrides.delete ?? (async () => {})),
    },
  } as unknown as Parameters<typeof playlistRoutes>[0];
}

function buildApp(navidrome: Parameters<typeof playlistRoutes>[0]) {
  const app = new Hono<AuthEnv>();
  const auth = authMiddleware(SECRET);
  app.use('*', auth);
  app.route('/', playlistRoutes(navidrome, testDb));
  return app;
}

// ── fixture playlists ──────────────────────────────────────────────────────────

const globalPlaylist  = { id: 'pl-global',  name: 'Global Mix', songCount: 3, duration: 600, owner: 'admin', public: true,  created: '', changed: '' };
const alicePersonal   = { id: 'pl-alice',   name: 'Alice Faves', songCount: 1, duration: 200, owner: 'admin', public: false, created: '', changed: '' };
const bobPersonal     = { id: 'pl-bob',     name: 'Bob Faves',   songCount: 2, duration: 300, owner: 'admin', public: false, created: '', changed: '' };
const legacyPlaylist  = { id: 'pl-legacy',  name: 'Old Stuff',   songCount: 5, duration: 900, owner: 'admin', public: false, created: '', changed: '' };

// ── setup: seed visibility rows before each test ──────────────────────────────

beforeEach(() => {
  testDb.run('DELETE FROM playlist_visibility');
  testDb.run("INSERT INTO playlist_visibility VALUES ('pl-global', 'u1', 'global')");
  testDb.run("INSERT INTO playlist_visibility VALUES ('pl-alice',  'u1', 'personal')");
  testDb.run("INSERT INTO playlist_visibility VALUES ('pl-bob',    'u2', 'personal')");
  // pl-legacy intentionally has NO row → legacy / treat as global
});

// ── GET / ─────────────────────────────────────────────────────────────────────

describe('GET /', () => {
  it('returns global playlists to any authenticated user', async () => {
    const nd = makeNavidrome({ list: async () => [globalPlaylist, alicePersonal, bobPersonal] });
    const app = buildApp(nd);
    const tok = await token('u2'); // bob
    const res = await app.request('/', { headers: { Authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ id: string }>;
    const ids = body.map((p) => p.id);
    expect(ids).toContain('pl-global');
  });

  it("returns the calling user's personal playlists", async () => {
    const nd = makeNavidrome({ list: async () => [globalPlaylist, alicePersonal, bobPersonal] });
    const app = buildApp(nd);
    const tok = await token('u1'); // alice
    const res = await app.request('/', { headers: { Authorization: `Bearer ${tok}` } });
    const body = await res.json() as Array<{ id: string }>;
    const ids = body.map((p) => p.id);
    expect(ids).toContain('pl-alice');
  });

  it("does not return another user's personal playlists", async () => {
    const nd = makeNavidrome({ list: async () => [globalPlaylist, alicePersonal, bobPersonal] });
    const app = buildApp(nd);
    const tok = await token('u2'); // bob should not see alice's personal
    const res = await app.request('/', { headers: { Authorization: `Bearer ${tok}` } });
    const body = await res.json() as Array<{ id: string }>;
    const ids = body.map((p) => p.id);
    expect(ids).not.toContain('pl-alice');
  });

  it('returns both global and own personal in a single list', async () => {
    const nd = makeNavidrome({ list: async () => [globalPlaylist, alicePersonal, bobPersonal] });
    const app = buildApp(nd);
    const tok = await token('u1'); // alice: sees global + own personal
    const res = await app.request('/', { headers: { Authorization: `Bearer ${tok}` } });
    const body = await res.json() as Array<{ id: string }>;
    const ids = body.map((p) => p.id);
    expect(ids).toContain('pl-global');
    expect(ids).toContain('pl-alice');
    expect(ids).not.toContain('pl-bob');
  });

  it('treats legacy playlists (no visibility row) as global — visible to everyone', async () => {
    const nd = makeNavidrome({ list: async () => [legacyPlaylist] });
    const app = buildApp(nd);
    const tok = await token('u2'); // bob has no connection to legacy playlist
    const res = await app.request('/', { headers: { Authorization: `Bearer ${tok}` } });
    const body = await res.json() as Array<{ id: string }>;
    expect(body.map((p) => p.id)).toContain('pl-legacy');
  });
});

// ── GET /:id ──────────────────────────────────────────────────────────────────

describe('GET /:id', () => {
  it('returns a global playlist to any user', async () => {
    const nd = makeNavidrome({ get: async () => globalPlaylist });
    const app = buildApp(nd);
    const tok = await token('u2');
    const res = await app.request('/pl-global', { headers: { Authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string };
    expect(body.id).toBe('pl-global');
  });

  it('returns a personal playlist to its owner', async () => {
    const nd = makeNavidrome({ get: async () => alicePersonal });
    const app = buildApp(nd);
    const tok = await token('u1'); // alice owns pl-alice
    const res = await app.request('/pl-alice', { headers: { Authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
  });

  it('returns 403 for a personal playlist owned by another user', async () => {
    const nd = makeNavidrome({ get: async () => alicePersonal });
    const app = buildApp(nd);
    const tok = await token('u2'); // bob cannot see alice's personal playlist
    const res = await app.request('/pl-alice', { headers: { Authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(403);
  });

  it('admin can access any personal playlist', async () => {
    const nd = makeNavidrome({ get: async () => alicePersonal });
    const app = buildApp(nd);
    const tok = await token('a1', 'admin');
    const res = await app.request('/pl-alice', { headers: { Authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
  });

  it('treats legacy (no visibility row) playlist as global — accessible to everyone', async () => {
    const nd = makeNavidrome({ get: async () => legacyPlaylist });
    const app = buildApp(nd);
    const tok = await token('u2');
    const res = await app.request('/pl-legacy', { headers: { Authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
  });
});

// ── POST / ────────────────────────────────────────────────────────────────────

describe('POST /', () => {
  it('returns 400 when name is missing', async () => {
    const nd = makeNavidrome();
    const app = buildApp(nd);
    const tok = await token('u1');
    const res = await app.request('/', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('creates a playlist in navidrome and stores ownership as personal by default', async () => {
    const nd = makeNavidrome();
    const app = buildApp(nd);
    const tok = await token('u1');
    const res = await app.request('/', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'My New Playlist' }),
    });
    expect(res.status).toBe(201);
    const row = testDb.query<{ playlist_id: string; owner_id: string; visibility: string }, [string]>('SELECT * FROM playlist_visibility WHERE playlist_id = ?').get('pl-new');
    expect(row).not.toBeNull();
    expect(row!.owner_id).toBe('u1');
    expect(row!.visibility).toBe('personal');
  });

  it('stores global visibility when explicitly requested', async () => {
    const nd = makeNavidrome();
    const app = buildApp(nd);
    const tok = await token('u1');
    const res = await app.request('/', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Shared Playlist', visibility: 'global' }),
    });
    expect(res.status).toBe(201);
    const row = testDb.query<{ playlist_id: string; owner_id: string; visibility: string }, [string]>('SELECT * FROM playlist_visibility WHERE playlist_id = ?').get('pl-new');
    expect(row!.visibility).toBe('global');
  });
});

// ── PATCH /:id/visibility ─────────────────────────────────────────────────────

describe('PATCH /:id/visibility', () => {
  it('owner can change visibility from personal to global', async () => {
    const nd = makeNavidrome({ get: async () => alicePersonal });
    const app = buildApp(nd);
    const tok = await token('u1');
    const res = await app.request('/pl-alice/visibility', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: 'global' }),
    });
    expect(res.status).toBe(200);
    const row = testDb.query<{ visibility: string }, [string]>('SELECT visibility FROM playlist_visibility WHERE playlist_id = ?').get('pl-alice');
    expect(row!.visibility).toBe('global');
  });

  it('owner can change visibility from global to personal', async () => {
    const nd = makeNavidrome({ get: async () => globalPlaylist });
    const app = buildApp(nd);
    const tok = await token('u1'); // u1 owns pl-global
    const res = await app.request('/pl-global/visibility', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: 'personal' }),
    });
    expect(res.status).toBe(200);
    const row = testDb.query<{ visibility: string }, [string]>('SELECT visibility FROM playlist_visibility WHERE playlist_id = ?').get('pl-global');
    expect(row!.visibility).toBe('personal');
  });

  it('non-owner gets 403', async () => {
    const nd = makeNavidrome({ get: async () => alicePersonal });
    const app = buildApp(nd);
    const tok = await token('u2'); // bob does not own pl-alice
    const res = await app.request('/pl-alice/visibility', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: 'global' }),
    });
    expect(res.status).toBe(403);
  });

  it('admin can change visibility of any playlist', async () => {
    const nd = makeNavidrome({ get: async () => alicePersonal });
    const app = buildApp(nd);
    const tok = await token('a1', 'admin');
    const res = await app.request('/pl-alice/visibility', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: 'global' }),
    });
    expect(res.status).toBe(200);
  });

  it('returns 400 for an invalid visibility value', async () => {
    const nd = makeNavidrome({ get: async () => alicePersonal });
    const app = buildApp(nd);
    const tok = await token('u1');
    const res = await app.request('/pl-alice/visibility', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: 'secret' }),
    });
    expect(res.status).toBe(400);
  });
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────

describe('DELETE /:id', () => {
  it('owner can delete their playlist', async () => {
    const nd = makeNavidrome();
    const app = buildApp(nd);
    const tok = await token('u1');
    const res = await app.request('/pl-alice', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(200);
    expect(nd.playlists.delete).toHaveBeenCalledWith('pl-alice');
  });

  it('non-owner gets 403 and navidrome.delete is NOT called', async () => {
    const nd = makeNavidrome();
    const app = buildApp(nd);
    const tok = await token('u2'); // bob does not own pl-alice
    const res = await app.request('/pl-alice', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(403);
    expect(nd.playlists.delete).not.toHaveBeenCalled();
  });

  it('admin can delete any playlist', async () => {
    const nd = makeNavidrome();
    const app = buildApp(nd);
    const tok = await token('a1', 'admin');
    const res = await app.request('/pl-bob', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(200);
    expect(nd.playlists.delete).toHaveBeenCalledWith('pl-bob');
  });

  it('removes the playlist_visibility row after deletion', async () => {
    const nd = makeNavidrome();
    const app = buildApp(nd);
    const tok = await token('u1');
    await app.request('/pl-alice', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tok}` },
    });
    const row = testDb.query<{ playlist_id: string; owner_id: string; visibility: string }, [string]>('SELECT * FROM playlist_visibility WHERE playlist_id = ?').get('pl-alice');
    expect(row).toBeNull();
  });

  it('admin can delete legacy playlist (no visibility row)', async () => {
    const nd = makeNavidrome();
    const app = buildApp(nd);
    const tok = await token('a1', 'admin');
    const res = await app.request('/pl-legacy', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(200);
  });

  it('non-admin cannot delete legacy playlist (no visibility row)', async () => {
    const nd = makeNavidrome();
    const app = buildApp(nd);
    const tok = await token('u1');
    const res = await app.request('/pl-legacy', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(403);
  });
});
