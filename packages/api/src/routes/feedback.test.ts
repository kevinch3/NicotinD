/**
 * Route tests for the generation-feedback capture API (admin-only): grade a
 * pending snapshot via PATCH, export via GET.
 */
import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { JwtPayload } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { applySchema } from '../db.js';
import { recordPendingFeedback } from '../services/generation-feedback.js';
import { feedbackRoutes } from './feedback.js';

let testDb: Database = (() => {
  const d = new Database(':memory:');
  applySchema(d);
  return d;
})();

mock.module('../db.js', () => ({
  getDatabase: () => testDb,
  initDatabase: () => testDb,
  applySchema,
}));

function authed(
  app: Hono<AuthEnv>,
  role: 'admin' | 'user' = 'admin',
  sub = 'admin1',
): Hono<AuthEnv> {
  const wrap = new Hono<AuthEnv>();
  wrap.use('*', async (c, next) => {
    c.set('user', { sub, username: 'boss', role, iat: 0, exp: 0 } as JwtPayload);
    await next();
  });
  wrap.route('/', app);
  return wrap;
}

function seedPending(userId = 'admin1'): number {
  return recordPendingFeedback(testDb, {
    userId,
    username: 'boss',
    resourceType: 'hunt-match',
    resourceRef: '42',
    input: { artistName: 'A', albumTitle: 'B', canonicalTracks: [{ title: 'T' }] },
    output: { rawResponses: [], candidates: [], chosen: null },
    engineVersion: '0.1.0',
  });
}

beforeEach(() => {
  testDb = new Database(':memory:');
  applySchema(testDb);
});

describe('feedback routes', () => {
  it('rejects non-admins on GET and PATCH', async () => {
    const app = authed(feedbackRoutes(), 'user');
    expect((await app.request('/')).status).toBe(403);
    expect(
      (
        await app.request('/1', {
          method: 'PATCH',
          body: JSON.stringify({ verdict: 'good' }),
          headers: { 'content-type': 'application/json' },
        })
      ).status,
    ).toBe(403);
  });

  it('PATCH grades a pending row and GET returns it', async () => {
    const id = seedPending();
    const app = authed(feedbackRoutes());

    const patch = await app.request(`/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        verdict: 'bad',
        note: 'wrong release',
        itemFlags: { correctFolder: { username: 'bob', directory: 'B/Album' } },
      }),
      headers: { 'content-type': 'application/json' },
    });
    expect(patch.status).toBe(200);

    const rows = await (await app.request('/?resourceType=hunt-match')).json();
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBe('bad');
    expect(rows[0].itemFlags.correctFolder.username).toBe('bob');
  });

  it('PATCH 404s an unknown / non-owned id', async () => {
    const app = authed(feedbackRoutes());
    const res = await app.request('/999', {
      method: 'PATCH',
      body: JSON.stringify({ verdict: 'good' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(404);
  });

  it('PATCH rejects an invalid verdict', async () => {
    const id = seedPending();
    const app = authed(feedbackRoutes());
    const res = await app.request(`/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ verdict: 'meh' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });

  it('GET graded=true returns only graded rows', async () => {
    const graded = seedPending();
    seedPending(); // pending
    const app = authed(feedbackRoutes());
    await app.request(`/${graded}`, {
      method: 'PATCH',
      body: JSON.stringify({ verdict: 'good' }),
      headers: { 'content-type': 'application/json' },
    });
    const rows = await (await app.request('/?graded=true')).json();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(graded);
  });
});
