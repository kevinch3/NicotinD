import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Hono } from 'hono';
import { shareRoutes } from './share.js';
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
testDb.run(`
  CREATE TABLE share_tokens (
    token             TEXT    PRIMARY KEY,
    resource_type     TEXT    NOT NULL,
    resource_id       TEXT    NOT NULL,
    created_by        TEXT    NOT NULL,
    created_at        INTEGER NOT NULL,
    first_accessed_at INTEGER,
    expires_at        INTEGER
  )
`);
testDb.run("INSERT INTO users VALUES ('u1', 'alice', 'hash', 'user', 'active', datetime('now'))");

mock.module('../db.js', () => ({ getDatabase: () => testDb }));

const SECRET = 'test-secret';

beforeEach(() => {
  testDb.run('DELETE FROM share_tokens');
});

function buildApp() {
  const app = new Hono<any>();
  const auth = authMiddleware(SECRET);
  app.route('/api/share', shareRoutes(SECRET, auth));
  return app;
}

describe('POST /api/share — generate', () => {
  it('returns 401 without auth', async () => {
    const app = buildApp();
    const res = await app.request('/api/share', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resourceType: 'album', resourceId: 'al1' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid resourceType', async () => {
    const app = buildApp();
    const token = await signJwt({ sub: 'u1', username: 'alice', role: 'user' }, SECRET);
    const res = await app.request('/api/share', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ resourceType: 'song', resourceId: 'x1' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns a share URL for a valid album', async () => {
    const app = buildApp();
    const token = await signJwt({ sub: 'u1', username: 'alice', role: 'user' }, SECRET);
    const res = await app.request('/api/share', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ resourceType: 'album', resourceId: 'al1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { url: string };
    expect(body.url).toMatch(/\/share\/[A-Za-z0-9_-]{22}$/);
  });
});

describe('POST /api/share/activate/:token — activate', () => {
  it('returns 404 for unknown token', async () => {
    const app = buildApp();
    const res = await app.request('/api/share/activate/nonexistent', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('activates on first call and returns jwt + resource info', async () => {
    const app = buildApp();
    // Insert a fresh token
    testDb.run(
      "INSERT INTO share_tokens VALUES ('tok1', 'album', 'al42', 'u1', ?, NULL, NULL)",
      [Date.now()]
    );
    const res = await app.request('/api/share/activate/tok1', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as { jwt: string; resourceType: string; resourceId: string };
    expect(body.resourceType).toBe('album');
    expect(body.resourceId).toBe('al42');
    expect(typeof body.jwt).toBe('string');
    // first_accessed_at is now set
    const row = testDb.query<any, [string]>('SELECT * FROM share_tokens WHERE token = ?').get('tok1');
    expect(row.first_accessed_at).not.toBeNull();
  });

  it('re-issues jwt with same exp on repeat call within window', async () => {
    const app = buildApp();
    const expiresAt = Date.now() + 300_000;
    testDb.run(
      "INSERT OR REPLACE INTO share_tokens VALUES ('tok2', 'playlist', 'pl1', 'u1', ?, ?, ?)",
      [Date.now() - 10_000, Date.now() - 5_000, expiresAt]
    );
    const res = await app.request('/api/share/activate/tok2', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as { jwt: string };
    // Decode JWT and check exp
    const [, payloadB64] = body.jwt.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    expect(payload.exp).toBe(Math.floor(expiresAt / 1000));
  });

  it('returns 410 for expired token', async () => {
    const app = buildApp();
    const past = Date.now() - 1000;
    testDb.run(
      "INSERT OR REPLACE INTO share_tokens VALUES ('tok3', 'album', 'al1', 'u1', ?, ?, ?)",
      [Date.now() - 400_000, Date.now() - 400_000, past]
    );
    const res = await app.request('/api/share/activate/tok3', { method: 'POST' });
    expect(res.status).toBe(410);
  });
});
