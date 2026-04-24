import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Hono } from 'hono';
import { authMiddleware, signJwt } from './auth.js';

// Mock getDatabase to use an in-memory DB with a test user
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
testDb.run("INSERT INTO users (id, username, password_hash, role) VALUES ('user-123', 'testuser', 'hash', 'user')");
testDb.run("INSERT INTO users (id, username, password_hash, role) VALUES ('user-456', 'queryuser', 'hash', 'admin')");

mock.module('../db.js', () => ({
  getDatabase: () => testDb,
}));

describe('authMiddleware', () => {
  const SECRET = 'test-secret';
  let app: Hono<any>;

  beforeEach(() => {
    app = new Hono();
    app.use('/protected', authMiddleware(SECRET));
    app.get('/protected', (c) => c.json({ ok: true, user: c.get('user') }));
  });

  it('returns 401 if no token is provided', async () => {
    const res = await app.request('/protected');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Missing or invalid Authorization header' });
  });

  it('returns 401 for an invalid token', async () => {
    const res = await app.request('/protected', {
      headers: { 'Authorization': 'Bearer invalid-token' }
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid or expired token' });
  });

  it('returns 200 for a valid token in the Authorization header', async () => {
    const payload = { sub: 'user-123', username: 'testuser', role: 'user' as const };
    const token = await signJwt(payload, SECRET);

    const res = await app.request('/protected', {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.ok).toBe(true);
    expect(data.user.username).toBe('testuser');
  });

  it('returns 200 for a valid token in the query parameter', async () => {
    const payload = { sub: 'user-456', username: 'queryuser', role: 'admin' as const };
    const token = await signJwt(payload, SECRET);

    const res = await app.request(`/protected?token=${token}`);

    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.user.username).toBe('queryuser');
  });

  it('returns 401 if token is signed with a different secret', async () => {
    const payload = { sub: 'user-123', username: 'testuser', role: 'user' as const };
    const token = await signJwt(payload, 'wrong-secret');

    const res = await app.request('/protected', {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    expect(res.status).toBe(401);
  });

  it('returns 403 for a disabled user', async () => {
    testDb.run("INSERT OR REPLACE INTO users (id, username, password_hash, role, status) VALUES ('user-disabled', 'disabled', 'hash', 'user', 'disabled')");

    const payload = { sub: 'user-disabled', username: 'disabled', role: 'user' as const };
    const token = await signJwt(payload, SECRET);

    const res = await app.request('/protected', {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Account disabled' });
  });
});

describe('authMiddleware — share JWT read-only guard', () => {
  it('allows GET requests with share JWTs', async () => {
    const app = new Hono<any>();
    app.use('/protected', authMiddleware('test-secret'));
    app.get('/protected', (c) => c.json({ ok: true }));

    const shareToken = await signJwt(
      { sub: 'user-123', username: 'testuser', role: 'user', share: true, scope: 'read' } as any,
      'test-secret',
    );
    const res = await app.request('/protected', {
      headers: { Authorization: `Bearer ${shareToken}` },
    });
    expect(res.status).toBe(200);
  });

  it('blocks non-GET requests with share JWTs', async () => {
    const app = new Hono<any>();
    app.use('/protected', authMiddleware('test-secret'));
    app.post('/protected', (c) => c.json({ ok: true }));

    const shareToken = await signJwt(
      { sub: 'user-123', username: 'testuser', role: 'user', share: true, scope: 'read' } as any,
      'test-secret',
    );
    const res = await app.request('/protected', {
      method: 'POST',
      headers: { Authorization: `Bearer ${shareToken}` },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Share sessions are read-only' });
  });
});
