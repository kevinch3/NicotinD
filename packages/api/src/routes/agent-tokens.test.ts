import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Hono } from 'hono';
import { applySchema } from '../db.js';
import { authMiddleware, signJwt } from '../middleware/auth.js';
import type { AuthEnv } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import {
  mintAgentToken,
  verifyAgentToken,
  listAgentTokens,
  revokeAgentToken,
  hashToken,
} from '../services/agent-tokens.js';

const testDb = new Database(':memory:');
applySchema(testDb);
testDb.run(
  "INSERT INTO users (id, username, password_hash, role) VALUES ('refiner1', 'rae', 'h', 'refiner')",
);
testDb.run(
  "INSERT INTO users (id, username, password_hash, role) VALUES ('listener1', 'leo', 'h', 'listener')",
);

mock.module('../db.js', () => ({ getDatabase: () => testDb, applySchema }));

const { agentTokensRoutes } = await import('./agent-tokens.js');

const SECRET = 'test-secret-at-least-32-chars-long-xx';

beforeEach(() => testDb.run('DELETE FROM agent_tokens'));

describe('agent-tokens service (issue #232)', () => {
  it('mints a prefixed token, stores only its hash, and verifies it', () => {
    const { id, token } = mintAgentToken(testDb, { userId: 'refiner1', name: 'Claude' });
    expect(token.startsWith('nca_')).toBe(true);

    const stored = testDb
      .query<{ token_hash: string }, [string]>('SELECT token_hash FROM agent_tokens WHERE id = ?')
      .get(id);
    // The raw token is never stored — only its hash.
    expect(stored?.token_hash).toBe(hashToken(token));
    expect(stored?.token_hash).not.toContain(token);

    const identity = verifyAgentToken(testDb, token);
    expect(identity).toEqual({ tokenId: id, userId: 'refiner1', scope: 'refiner:curate' });
  });

  it('refuses an unknown, malformed, revoked, or expired token', () => {
    expect(verifyAgentToken(testDb, undefined)).toBeNull();
    expect(verifyAgentToken(testDb, 'not-a-token')).toBeNull();
    expect(verifyAgentToken(testDb, 'nca_bogus')).toBeNull();

    const revoked = mintAgentToken(testDb, { userId: 'refiner1', name: 'x' });
    revokeAgentToken(testDb, 'refiner1', revoked.id);
    expect(verifyAgentToken(testDb, revoked.token)).toBeNull();

    const expired = mintAgentToken(testDb, {
      userId: 'refiner1',
      name: 'y',
      expiresAt: 1_000,
      now: 500,
    });
    expect(verifyAgentToken(testDb, expired.token, 2_000)).toBeNull();
    // …still valid before it lapses.
    expect(verifyAgentToken(testDb, expired.token, 900)).not.toBeNull();
  });

  it('only lets a user revoke their OWN token', () => {
    const mine = mintAgentToken(testDb, { userId: 'refiner1', name: 'mine' });
    // A different user cannot revoke it.
    expect(revokeAgentToken(testDb, 'listener1', mine.id)).toBe(false);
    expect(verifyAgentToken(testDb, mine.token)).not.toBeNull();
    // The owner can.
    expect(revokeAgentToken(testDb, 'refiner1', mine.id)).toBe(true);
  });

  it('lists a user’s own tokens without exposing the hash', () => {
    mintAgentToken(testDb, { userId: 'refiner1', name: 'a' });
    mintAgentToken(testDb, { userId: 'listener1', name: 'b' });
    const rows = listAgentTokens(testDb, 'refiner1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('a');
    expect(rows[0]).not.toHaveProperty('token_hash');
  });
});

function buildApp() {
  const app = new Hono<AuthEnv>();
  app.onError(errorHandler);
  app.use('/api/agent-tokens/*', authMiddleware(SECRET));
  app.route('/api/agent-tokens', agentTokensRoutes());
  return app;
}

async function req(role: 'refiner' | 'listener', path: string, init: RequestInit = {}) {
  const token = await signJwt(
    { sub: role === 'refiner' ? 'refiner1' : 'listener1', username: 'u', role },
    SECRET,
  );
  // '/' maps to the bare mount path (Hono 404s a trailing slash on a sub-app '/').
  const suffix = path === '/' ? '' : path;
  return buildApp().request(`http://x/api/agent-tokens${suffix}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

describe('agent-tokens routes', () => {
  it('lets a curator mint a token and returns the secret exactly once', async () => {
    const res = await req('refiner', '/', {
      method: 'POST',
      body: JSON.stringify({ name: 'Claude' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; token: string; scope: string };
    expect(body.token.startsWith('nca_')).toBe(true);
    expect(body.scope).toBe('refiner:curate');

    // The secret is never retrievable again — the list omits it.
    const list = await req('refiner', '/');
    const listed = (await list.json()) as { tokens: Array<{ id: string }> };
    expect(listed.tokens.map((t) => t.id)).toContain(body.id);
    expect(JSON.stringify(listed)).not.toContain(body.token);
  });

  it('refuses a listener (not a curator)', async () => {
    const res = await req('listener', '/', { method: 'POST', body: JSON.stringify({ name: 'x' }) });
    expect(res.status).toBe(403);
  });

  it('rejects a missing name and an invalid scope, with stable codes (#236)', async () => {
    const missingName = await req('refiner', '/', { method: 'POST', body: '{}' });
    expect(missingName.status).toBe(400);
    expect(((await missingName.json()) as { code: string }).code).toBe('VALIDATION_ERROR');
    const bad = await req('refiner', '/', {
      method: 'POST',
      body: JSON.stringify({ name: 'x', scope: 'admin:all' }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe('VALIDATION_ERROR');
  });

  it('revokes a token and 404s an unknown id, with a stable code (#236)', async () => {
    const mint = await req('refiner', '/', { method: 'POST', body: JSON.stringify({ name: 'x' }) });
    const { id } = (await mint.json()) as { id: string };
    expect((await req('refiner', `/${id}`, { method: 'DELETE' })).status).toBe(200);
    const notFound = await req('refiner', `/${id}`, { method: 'DELETE' });
    expect(notFound.status).toBe(404);
    expect(((await notFound.json()) as { code: string }).code).toBe('NOT_FOUND');
  });
});
