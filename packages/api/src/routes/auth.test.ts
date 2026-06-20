import { describe, expect, it, beforeAll, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as jose from 'jose';
import { applySchema } from '../db.js';
import { signJwt } from '../middleware/auth.js';

// In-memory DB with a test user (mirrors middleware/auth.test.ts).
const testDb = new Database(':memory:');
applySchema(testDb);
testDb.run(
  "INSERT INTO users (id, username, password_hash, role) VALUES ('user-123', 'testuser', 'hash', 'user')",
);

mock.module('../db.js', () => ({
  getDatabase: () => testDb,
  applySchema,
}));

const SECRET = 'test-secret-at-least-32-chars-long-xx';

describe('POST /refresh', () => {
  let app: Awaited<ReturnType<typeof makeApp>>;

  async function makeApp() {
    const { authRoutes } = await import('./auth.js');
    return authRoutes(SECRET, '30d', true);
  }

  beforeAll(async () => {
    app = await makeApp();
  });

  it('returns 401 when no token is provided', async () => {
    const res = await app.request('/refresh', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('returns 401 for an invalid token', async () => {
    const res = await app.request('/refresh', {
      method: 'POST',
      headers: { Authorization: 'Bearer not-a-real-token' },
    });
    expect(res.status).toBe(401);
  });

  it('returns a fresh, valid token for a currently-valid token', async () => {
    const token = await signJwt(
      { sub: 'user-123', username: 'testuser', role: 'user' },
      SECRET,
      '1h',
    );

    const res = await app.request('/refresh', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(typeof body.token).toBe('string');

    // The renewed token must verify and carry the same identity.
    const { payload } = await jose.jwtVerify(body.token, new TextEncoder().encode(SECRET));
    expect(payload.sub).toBe('user-123');
    expect(payload.username).toBe('testuser');
  });

  it('refuses to refresh a share token (403)', async () => {
    const shareToken = await signJwt(
      { sub: 'user-123', username: 'testuser', role: 'user', share: true, scope: 'read' },
      SECRET,
    );

    const res = await app.request('/refresh', {
      method: 'POST',
      headers: { Authorization: `Bearer ${shareToken}` },
    });

    expect(res.status).toBe(403);
  });
});
