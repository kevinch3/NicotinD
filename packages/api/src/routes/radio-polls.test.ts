/**
 * Route tests for radio evaluation polls: the admin create/list/results/close/
 * delete surface and the public token-gated view + vote endpoints. The public
 * endpoints must never 401 — the web auth interceptor bounces any 401 to
 * /login, which would eject an anonymous rater mid-wizard.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import * as jose from 'jose';
import type { JwtPayload, PublicPollView } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import { applySchema } from '../db.js';
import { radioPollAdminRoutes, radioPollPublicRoutes } from './radio-polls.js';

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

const JWT_SECRET = 'test-secret';

function adminApp(role: 'admin' | 'user' = 'admin'): Hono<AuthEnv> {
  const wrap = new Hono<AuthEnv>();
  wrap.onError(errorHandler);
  wrap.use('*', async (c, next) => {
    c.set('user', { sub: 'u1', username: 'boss', role, iat: 0, exp: 0 } as JwtPayload);
    await next();
  });
  wrap.route('/', radioPollAdminRoutes({ version: '0.1.0-test' }));
  return wrap;
}

function publicApp(): Hono {
  const app = new Hono();
  app.onError(errorHandler);
  app.route('/', radioPollPublicRoutes(JWT_SECRET));
  return app;
}

function seedSong(s: { id: string; title: string; artist: string; genre?: string }): void {
  const albumId = `alb-${s.id}`;
  testDb.run(
    `INSERT OR IGNORE INTO library_albums (id, name, artist, artist_id, song_count, duration, created, synced_at)
     VALUES (?, ?, ?, ?, 1, 0, '2024-01-01', 0)`,
    [albumId, `Album ${s.id}`, s.artist, s.artist],
  );
  testDb.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, genre, bpm, landed_at, synced_at)
     VALUES (?, ?, ?, ?, ?, 240, ?, 0, 320, 'mp3', 'audio/mpeg', '2024-01-01', ?, 120, 1, 0)`,
    [s.id, albumId, s.title, s.artist, s.artist, `/music/${s.id}.mp3`, s.genre ?? 'Rock'],
  );
}

function seedLibrary(n = 6): void {
  testDb.run("INSERT INTO users (id, username, password_hash) VALUES ('u1','boss','x')");
  for (let i = 0; i < n; i++) {
    seedSong({ id: `s${i}`, title: `Song ${i}`, artist: `Artist ${i}` });
  }
}

async function createPollViaRoute(
  body: Record<string, unknown> = {},
): Promise<{ id: string; token: string; url: string }> {
  const res = await adminApp().request('/', {
    method: 'POST',
    body: JSON.stringify({ name: 'Poll', scenarioCount: 2, nextUpCount: 2, ...body }),
    headers: { 'content-type': 'application/json' },
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; token: string; url: string };
}

const RATER = 'rater-device-abc';

beforeEach(() => {
  testDb = new Database(':memory:');
  applySchema(testDb);
});

describe('admin radio-poll routes', () => {
  it('rejects non-admins on every handler', async () => {
    const app = adminApp('user');
    expect((await app.request('/')).status).toBe(403);
    expect((await app.request('/', { method: 'POST', body: '{}' })).status).toBe(403);
    expect((await app.request('/x', { method: 'DELETE' })).status).toBe(403);
    expect((await app.request('/x/close', { method: 'POST' })).status).toBe(403);
  });

  it('create → list → results → close → delete round-trips', async () => {
    seedLibrary();
    const created = await createPollViaRoute();
    expect(created.url).toContain(`/poll/${created.token}`);

    const list = (await (await adminApp().request('/')).json()) as Array<{
      id: string;
      scenarioCount: number;
      url: string;
    }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.scenarioCount).toBe(2);
    expect(list[0]!.url).toBe(created.url);

    const results = (await (await adminApp().request(`/${created.id}`)).json()) as {
      scenarios: Array<{ candidates: Array<{ up: number; explanation: unknown }> }>;
    };
    expect(results.scenarios).toHaveLength(2);
    // The admin surface keeps the full snapshot incl. per-axis explanations.
    expect(results.scenarios[0]!.candidates[0]!.explanation).toBeDefined();

    expect((await adminApp().request(`/${created.id}/close`, { method: 'POST' })).status).toBe(200);
    expect((await adminApp().request(`/${created.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await adminApp().request(`/${created.id}`)).status).toBe(404);
  });

  it('records audit rows for create/close/delete', async () => {
    seedLibrary();
    const created = await createPollViaRoute();
    await adminApp().request(`/${created.id}/close`, { method: 'POST' });
    await adminApp().request(`/${created.id}`, { method: 'DELETE' });
    const actions = testDb
      .query<{ action: string }, []>('SELECT action FROM audit_log ORDER BY id')
      .all()
      .map((r) => r.action);
    expect(actions).toEqual(['radio-poll.create', 'radio-poll.close', 'radio-poll.delete']);
  });

  it('400s on a missing name, an unknown weight axis and an empty library', async () => {
    seedLibrary();
    const noName = await adminApp().request('/', {
      method: 'POST',
      body: JSON.stringify({ scenarioCount: 1 }),
      headers: { 'content-type': 'application/json' },
    });
    expect(noName.status).toBe(400);

    const badWeights = await adminApp().request('/', {
      method: 'POST',
      body: JSON.stringify({ name: 'P', weights: { vibes: 3 } }),
      headers: { 'content-type': 'application/json' },
    });
    expect(badWeights.status).toBe(400);

    testDb.run('DELETE FROM library_songs');
    const empty = await adminApp().request('/', {
      method: 'POST',
      body: JSON.stringify({ name: 'P' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(empty.status).toBe(400);
  });
});

describe('public radio-poll routes', () => {
  it('unknown token → 404; unauthenticated GET is never 401', async () => {
    const res = await publicApp().request('/public/nope');
    expect(res.status).toBe(404);
  });

  it('serves the lean public view with a share-scoped media JWT', async () => {
    seedLibrary();
    const { token } = await createPollViaRoute();
    const res = await publicApp().request(`/public/${token}`);
    expect(res.status).toBe(200);
    const view = (await res.json()) as PublicPollView;
    expect(view.poll.name).toBe('Poll');
    expect(view.scenarios).toHaveLength(2);
    const candidate = view.scenarios[0]!.candidates[0]! as unknown as Record<string, unknown>;
    expect(candidate['score']).toBeUndefined();
    expect(candidate['explanation']).toBeUndefined();

    // The media JWT verifies as a read-only share token for the poll creator.
    const { payload } = await jose.jwtVerify(view.mediaJwt, new TextEncoder().encode(JWT_SECRET));
    expect(payload['share']).toBe(true);
    expect(payload['scope']).toBe('read');
    expect(payload.sub).toBe('u1');
    expect(view.mediaJwtExpiresAt).toBeGreaterThan(Date.now());

    // Re-fetch is idempotent and refreshes the JWT (multi-visit by design).
    expect((await publicApp().request(`/public/${token}`)).status).toBe(200);
  });

  it('accepts votes, validates ids, and reports them in admin results', async () => {
    seedLibrary();
    const { id, token } = await createPollViaRoute();
    const view = (await (await publicApp().request(`/public/${token}`)).json()) as PublicPollView;
    const scenario = view.scenarios[0]!;

    const ok = await publicApp().request(`/public/${token}/votes`, {
      method: 'POST',
      body: JSON.stringify({
        raterKey: RATER,
        votes: [
          { scenarioId: scenario.id, candidateSongId: scenario.candidates[0]!.id, verdict: 'up' },
        ],
      }),
      headers: { 'content-type': 'application/json' },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ recorded: 1 });

    const bad = await publicApp().request(`/public/${token}/votes`, {
      method: 'POST',
      body: JSON.stringify({
        raterKey: RATER,
        votes: [{ scenarioId: scenario.id, candidateSongId: 'not-in-scenario', verdict: 'up' }],
      }),
      headers: { 'content-type': 'application/json' },
    });
    expect(bad.status).toBe(400);

    const results = (await (await adminApp().request(`/${id}`)).json()) as {
      poll: { voteCount: number; raterCount: number };
    };
    expect(results.poll.voteCount).toBe(1);
    expect(results.poll.raterCount).toBe(1);
  });

  it('closed poll → 410 POLL_CLOSED on view and vote', async () => {
    seedLibrary();
    const { id, token } = await createPollViaRoute();
    const view = (await (await publicApp().request(`/public/${token}`)).json()) as PublicPollView;
    await adminApp().request(`/${id}/close`, { method: 'POST' });

    const res = await publicApp().request(`/public/${token}`);
    expect(res.status).toBe(410);
    expect(((await res.json()) as { code: string }).code).toBe('POLL_CLOSED');

    const vote = await publicApp().request(`/public/${token}/votes`, {
      method: 'POST',
      body: JSON.stringify({
        raterKey: RATER,
        votes: [
          {
            scenarioId: view.scenarios[0]!.id,
            candidateSongId: view.scenarios[0]!.candidates[0]!.id,
            verdict: 'up',
          },
        ],
      }),
      headers: { 'content-type': 'application/json' },
    });
    expect(vote.status).toBe(410);
  });

  it('expired poll → 410 POLL_EXPIRED', async () => {
    seedLibrary();
    const { id, token } = await createPollViaRoute({ expiresInHours: 1 });
    testDb.run('UPDATE radio_polls SET expires_at = ? WHERE id = ?', [Date.now() - 1000, id]);
    const res = await publicApp().request(`/public/${token}`);
    expect(res.status).toBe(410);
    expect(((await res.json()) as { code: string }).code).toBe('POLL_EXPIRED');
  });

  it('400s on malformed JSON without throwing', async () => {
    seedLibrary();
    const { token } = await createPollViaRoute();
    const res = await publicApp().request(`/public/${token}/votes`, {
      method: 'POST',
      body: 'not json',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });
});
