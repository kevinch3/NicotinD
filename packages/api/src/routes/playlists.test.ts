import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Hono } from 'hono';
import { playlistRoutes } from './playlists.js';
import { authMiddleware, signJwt } from '../middleware/auth.js';
import type { AuthEnv } from '../middleware/auth.js';
import { applySchema } from '../db.js';

// ── in-memory DB ──────────────────────────────────────────────────────────────

const testDb = new Database(':memory:');
applySchema(testDb);
testDb.run("INSERT INTO users (id, username, password_hash, role) VALUES ('u1', 'alice', 'hash', 'user')");
testDb.run("INSERT INTO users (id, username, password_hash, role) VALUES ('u2', 'bob',   'hash', 'user')");
testDb.run("INSERT INTO users (id, username, password_hash, role) VALUES ('a1', 'admin', 'hash', 'admin')");

mock.module('../db.js', () => ({ getDatabase: () => testDb, applySchema }));

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

const alicePlaylist  = { id: 'pl-alice',  name: 'Alice Mix',  songCount: 1, duration: 200, owner: 'admin', public: false, created: '', changed: '' };
const bobPlaylist    = { id: 'pl-bob',    name: 'Bob Mix',    songCount: 2, duration: 300, owner: 'admin', public: false, created: '', changed: '' };
const legacyPlaylist = { id: 'pl-legacy', name: 'Old Stuff',  songCount: 5, duration: 900, owner: 'admin', public: false, created: '', changed: '' };
const orphanPlaylist = { id: 'pl-orphan', name: 'No Metadata', songCount: 0, duration: 0, owner: 'admin', public: false, created: '', changed: '' };

// ── setup: seed visibility rows before each test ──────────────────────────────

beforeEach(() => {
  testDb.run('DELETE FROM playlist_visibility');
  testDb.run(
    `INSERT INTO playlist_visibility
       (playlist_id, owner_id, visibility, created_by, created_at, modified_by, modified_at)
     VALUES ('pl-alice', 'u1', 'global', 'u1', '2024-01-01 00:00:00', 'u1', '2024-01-01 00:00:00')`,
  );
  testDb.run(
    `INSERT INTO playlist_visibility
       (playlist_id, owner_id, visibility, created_by, created_at, modified_by, modified_at)
     VALUES ('pl-bob', 'u2', 'global', 'u2', '2024-01-02 00:00:00', 'u2', '2024-01-02 00:00:00')`,
  );
  // pl-legacy: only owner_id set (created_by NULL) — simulates a row migrated from old schema
  testDb.run(
    `INSERT INTO playlist_visibility (playlist_id, owner_id, visibility) VALUES ('pl-legacy', 'u1', 'global')`,
  );
  // pl-orphan: no metadata row at all (a Navidrome playlist created outside NicotinD)
});

// ── GET / ─────────────────────────────────────────────────────────────────────

describe('GET /', () => {
  it('returns every playlist to every user (no per-user filtering)', async () => {
    const nd = makeNavidrome({ list: async () => [alicePlaylist, bobPlaylist, legacyPlaylist] });
    const app = buildApp(nd);
    const tok = await token('u2'); // bob
    const res = await app.request('/', { headers: { Authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ id: string }>;
    const ids = body.map((p) => p.id);
    expect(ids).toContain('pl-alice');
    expect(ids).toContain('pl-bob');
    expect(ids).toContain('pl-legacy');
  });

  it('enriches each item with createdBy / modifiedBy resolved to usernames', async () => {
    const nd = makeNavidrome({ list: async () => [alicePlaylist, bobPlaylist] });
    const app = buildApp(nd);
    const tok = await token('u2');
    const res = await app.request('/', { headers: { Authorization: `Bearer ${tok}` } });
    const body = await res.json() as Array<{ id: string; createdBy: string | null; modifiedBy: string | null }>;
    const byId = new Map(body.map((p) => [p.id, p]));
    expect(byId.get('pl-alice')!.createdBy).toBe('alice');
    expect(byId.get('pl-alice')!.modifiedBy).toBe('alice');
    expect(byId.get('pl-bob')!.createdBy).toBe('bob');
  });

  it('returns null createdBy / modifiedBy for legacy rows and orphans', async () => {
    const nd = makeNavidrome({ list: async () => [legacyPlaylist, orphanPlaylist] });
    const app = buildApp(nd);
    const tok = await token('u1');
    const res = await app.request('/', { headers: { Authorization: `Bearer ${tok}` } });
    const body = await res.json() as Array<{ id: string; createdBy: string | null; modifiedBy: string | null }>;
    const byId = new Map(body.map((p) => [p.id, p]));
    expect(byId.get('pl-legacy')!.createdBy).toBeNull();
    expect(byId.get('pl-orphan')!.createdBy).toBeNull();
  });
});

// ── GET /:id ──────────────────────────────────────────────────────────────────

describe('GET /:id', () => {
  it('returns any playlist to any authenticated user (no access check)', async () => {
    const nd = makeNavidrome({ get: async () => alicePlaylist });
    const app = buildApp(nd);
    const tok = await token('u2'); // bob fetching alice's playlist
    const res = await app.request('/pl-alice', { headers: { Authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
  });

  it('includes resolved createdBy / createdAt / modifiedBy / modifiedAt fields', async () => {
    const nd = makeNavidrome({ get: async () => alicePlaylist });
    const app = buildApp(nd);
    const tok = await token('u2');
    const res = await app.request('/pl-alice', { headers: { Authorization: `Bearer ${tok}` } });
    const body = await res.json() as { createdBy: string; createdAt: string; modifiedBy: string; modifiedAt: string };
    expect(body.createdBy).toBe('alice');
    expect(body.createdAt).toBe('2024-01-01 00:00:00');
    expect(body.modifiedBy).toBe('alice');
    expect(body.modifiedAt).toBe('2024-01-01 00:00:00');
  });

  it('returns nulls for an orphan Navidrome playlist (no metadata row)', async () => {
    const nd = makeNavidrome({ get: async () => orphanPlaylist });
    const app = buildApp(nd);
    const tok = await token('u1');
    const res = await app.request('/pl-orphan', { headers: { Authorization: `Bearer ${tok}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as { createdBy: string | null; modifiedBy: string | null };
    expect(body.createdBy).toBeNull();
    expect(body.modifiedBy).toBeNull();
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

  it('inserts a metadata row tagged with the creating user, visibility=global', async () => {
    const nd = makeNavidrome();
    const app = buildApp(nd);
    const tok = await token('u1');
    const res = await app.request('/', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'My New Playlist' }),
    });
    expect(res.status).toBe(201);
    const row = testDb
      .query<{ owner_id: string; visibility: string; created_by: string; created_at: string; modified_by: string; modified_at: string }, [string]>(
        'SELECT * FROM playlist_visibility WHERE playlist_id = ?',
      )
      .get('pl-new');
    expect(row).not.toBeNull();
    expect(row!.owner_id).toBe('u1');
    expect(row!.visibility).toBe('global');
    expect(row!.created_by).toBe('u1');
    expect(row!.created_at).not.toBeNull();
    expect(row!.modified_by).toBe('u1');
    expect(row!.modified_at).not.toBeNull();
  });

  it('returns the created playlist enriched with createdBy / modifiedBy', async () => {
    const nd = makeNavidrome();
    const app = buildApp(nd);
    const tok = await token('u1');
    const res = await app.request('/', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Trip Mix' }),
    });
    const body = await res.json() as { id: string; createdBy: string; modifiedBy: string };
    expect(body.createdBy).toBe('alice');
    expect(body.modifiedBy).toBe('alice');
  });

  it('silently ignores a legacy visibility param in the body', async () => {
    const nd = makeNavidrome();
    const app = buildApp(nd);
    const tok = await token('u1');
    const res = await app.request('/', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Shared Playlist', visibility: 'personal' }),
    });
    expect(res.status).toBe(201);
    const row = testDb
      .query<{ visibility: string }, [string]>('SELECT visibility FROM playlist_visibility WHERE playlist_id = ?')
      .get('pl-new');
    expect(row!.visibility).toBe('global');
  });
});

// ── PUT /:id ──────────────────────────────────────────────────────────────────

describe('PUT /:id', () => {
  it('bumps modified_by and modified_at without altering created_by / created_at', async () => {
    const nd = makeNavidrome();
    const app = buildApp(nd);
    const tok = await token('u2'); // bob edits alice's playlist
    const res = await app.request('/pl-alice', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(res.status).toBe(200);
    const row = testDb
      .query<{ created_by: string; created_at: string; modified_by: string; modified_at: string }, [string]>(
        'SELECT created_by, created_at, modified_by, modified_at FROM playlist_visibility WHERE playlist_id = ?',
      )
      .get('pl-alice');
    expect(row!.created_by).toBe('u1');
    expect(row!.created_at).toBe('2024-01-01 00:00:00');
    expect(row!.modified_by).toBe('u2');
    expect(row!.modified_at).not.toBe('2024-01-01 00:00:00');
  });

  it('inserts a metadata row for an orphan Navidrome playlist on first edit', async () => {
    const nd = makeNavidrome();
    const app = buildApp(nd);
    const tok = await token('u2');
    await app.request('/pl-orphan', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Adopted' }),
    });
    const row = testDb
      .query<{ created_by: string; modified_by: string }, [string]>(
        'SELECT created_by, modified_by FROM playlist_visibility WHERE playlist_id = ?',
      )
      .get('pl-orphan');
    expect(row).not.toBeNull();
    expect(row!.created_by).toBe('u2');
    expect(row!.modified_by).toBe('u2');
  });
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────

describe('DELETE /:id', () => {
  it('creator can delete their playlist', async () => {
    const nd = makeNavidrome();
    const app = buildApp(nd);
    const tok = await token('u1'); // alice created pl-alice
    const res = await app.request('/pl-alice', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(200);
    expect(nd.playlists.delete).toHaveBeenCalledWith('pl-alice');
  });

  it('non-creator gets 403 and navidrome.delete is NOT called', async () => {
    const nd = makeNavidrome();
    const app = buildApp(nd);
    const tok = await token('u2'); // bob is not the creator
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
    const row = testDb
      .query<{ playlist_id: string }, [string]>('SELECT * FROM playlist_visibility WHERE playlist_id = ?')
      .get('pl-alice');
    expect(row).toBeNull();
  });

  it('falls back to owner_id when created_by is NULL (legacy row): owner can delete', async () => {
    const nd = makeNavidrome();
    const app = buildApp(nd);
    const tok = await token('u1'); // u1 is owner_id on the legacy row
    const res = await app.request('/pl-legacy', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(200);
  });

  it('falls back to owner_id when created_by is NULL: non-owner non-admin gets 403', async () => {
    const nd = makeNavidrome();
    const app = buildApp(nd);
    const tok = await token('u2'); // bob is neither owner nor admin
    const res = await app.request('/pl-legacy', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(403);
  });

  it('admin can delete an orphan playlist (no metadata row at all)', async () => {
    const nd = makeNavidrome();
    const app = buildApp(nd);
    const tok = await token('a1', 'admin');
    const res = await app.request('/pl-orphan', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(200);
  });

  it('non-admin cannot delete an orphan playlist', async () => {
    const nd = makeNavidrome();
    const app = buildApp(nd);
    const tok = await token('u1');
    const res = await app.request('/pl-orphan', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(403);
  });
});
