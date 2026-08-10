/**
 * Route tests for a user's own privacy controls (issue #454). The properties
 * worth pinning: consent is enforced server-side on the write path, and every
 * endpoint is caller-scoped with no way to reach anyone else's data.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { AuthEnv } from '../middleware/auth.js';
import { applySchema } from '../db.js';

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

const { privacyRoutes } = await import('./privacy.js');
const { historyRoutes } = await import('./history.js');
const { setUserHistoryEnabled, setInstanceHistoryEnabled } = await import('../services/privacy.js');

function makeApp(userId: string, historyEnabled = true) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { sub: userId, username: userId } as AuthEnv['Variables']['user']);
    await next();
  });
  app.route(
    '/privacy',
    privacyRoutes(() => historyEnabled),
  );
  app.route(
    '/history',
    historyRoutes(() => historyEnabled),
  );
  return app;
}

let seq = 0;
function event(over: Record<string, unknown> = {}) {
  seq += 1;
  return {
    clientEventId: `evt-${seq}`,
    songId: 's1',
    startedAt: 1_700_000_000_000 + seq,
    msPlayed: 200_000,
    durationMs: 300_000,
    reason: 'ended',
    source: null,
    device: null,
    title: 'T',
    artist: 'A',
    album: 'Al',
    ...over,
  };
}

function postPlays(app: Hono<AuthEnv>, events: unknown[]) {
  return app.request('/history/plays', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events }),
  });
}

beforeEach(() => {
  testDb = new Database(':memory:');
  applySchema(testDb);
  testDb.run(
    "INSERT INTO users (id, username, password_hash) VALUES ('u1','a','x'),('u2','b','y')",
  );
});

describe('consent enforcement on the write path', () => {
  it('records plays by default — opt-out means on', async () => {
    const res = await postPlays(makeApp('u1'), [event()]);
    expect(await res.json()).toMatchObject({ inserted: 1 });
  });

  it('records nothing once the user opts out', async () => {
    setUserHistoryEnabled(testDb, 'u1', false);
    const body = (await (await postPlays(makeApp('u1'), [event()])).json()) as {
      inserted: number;
      collection: { blockedBy: string };
    };
    expect(body.inserted).toBe(0);
    expect(body.collection.blockedBy).toBe('user');
    expect(testDb.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM play_events').get()?.n).toBe(
      0,
    );
  });

  it('records nothing when the instance turned it off', async () => {
    setInstanceHistoryEnabled(testDb, false);
    const body = (await (await postPlays(makeApp('u1'), [event()])).json()) as {
      collection: { blockedBy: string };
    };
    expect(body.collection.blockedBy).toBe('instance');
  });

  it('records nothing when the env floor is down, whatever the user set', async () => {
    setUserHistoryEnabled(testDb, 'u1', true);
    const body = (await (await postPlays(makeApp('u1', false), [event()])).json()) as {
      collection: { blockedBy: string };
    };
    expect(body.collection.blockedBy).toBe('env');
  });

  it('tells the client it was refused rather than faking success', async () => {
    // A silent 200-with-inserted-1 would make the client drop its buffer while
    // nothing was stored; reporting the refusal lets it stop retrying instead.
    setUserHistoryEnabled(testDb, 'u1', false);
    const body = (await (await postPlays(makeApp('u1'), [event()])).json()) as {
      collection: { enabled: boolean };
    };
    expect(body.collection.enabled).toBe(false);
  });
});

describe('GET /privacy', () => {
  it('reports the caller’s consent and the retention policy', async () => {
    const body = (await (await makeApp('u1').request('/privacy')).json()) as {
      historyEnabled: boolean;
      retentionDays: number;
    };
    expect(body).toMatchObject({ historyEnabled: true, retentionDays: 0 });
  });

  it('names the env as the blocker so the UI can explain rather than offer a fix', async () => {
    const body = (await (await makeApp('u1', false).request('/privacy')).json()) as {
      collection: { blockedBy: string };
    };
    expect(body.collection.blockedBy).toBe('env');
  });
});

describe('PUT /privacy/history-consent', () => {
  function put(app: Hono<AuthEnv>, payload: unknown) {
    return app.request('/privacy/history-consent', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  it('turns collection off for the caller', async () => {
    const res = await put(makeApp('u1'), { enabled: false });
    expect(await res.json()).toMatchObject({ historyEnabled: false });
    expect(
      (await (await postPlays(makeApp('u1'), [event()])).json()) as { inserted: number },
    ).toMatchObject({ inserted: 0 });
  });

  it('does not change anyone else', async () => {
    await put(makeApp('u1'), { enabled: false });
    const other = (await (await makeApp('u2').request('/privacy')).json()) as {
      historyEnabled: boolean;
    };
    expect(other.historyEnabled).toBe(true);
  });

  it('400s on a non-boolean', async () => {
    const res = await put(makeApp('u1'), { enabled: 'yes' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('GET /privacy/export', () => {
  it('returns the caller’s data as a downloadable attachment', async () => {
    await postPlays(makeApp('u1'), [event({ songId: 'mine' })]);
    const res = await makeApp('u1').request('/privacy/export');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    const body = (await res.json()) as { user: { username: string }; tables: Record<string, []> };
    expect(body.user.username).toBe('a');
    expect(body.tables['play_events']).toHaveLength(1);
  });

  it('never contains another user’s rows or any password hash', async () => {
    await postPlays(makeApp('u1'), [event({ songId: 'mine' })]);
    await postPlays(makeApp('u2'), [event({ songId: 'theirs' })]);

    const json = JSON.stringify(await (await makeApp('u1').request('/privacy/export')).json());
    expect(json).toContain('mine');
    expect(json).not.toContain('theirs');
    expect(json).not.toContain('password_hash');
  });
});

describe('DELETE /privacy/history', () => {
  it('erases the caller’s history and reports the count', async () => {
    await postPlays(makeApp('u1'), [event(), event()]);
    const res = await makeApp('u1').request('/privacy/history', { method: 'DELETE' });
    expect(await res.json()).toEqual({ deleted: 2 });
    expect(testDb.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM play_events').get()?.n).toBe(
      0,
    );
  });

  it('leaves other users untouched', async () => {
    await postPlays(makeApp('u1'), [event()]);
    await postPlays(makeApp('u2'), [event()]);
    await makeApp('u1').request('/privacy/history', { method: 'DELETE' });
    expect(testDb.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM play_events').get()?.n).toBe(
      1,
    );
  });

  it('audit-logs the erasure without recording what was listened to', async () => {
    await postPlays(makeApp('u1'), [event({ title: 'A Very Private Song' })]);
    await makeApp('u1').request('/privacy/history', { method: 'DELETE' });

    const row = testDb
      .query<{ action: string; detail: string | null }, []>(
        'SELECT action, detail FROM audit_log ORDER BY id DESC LIMIT 1',
      )
      .get();
    expect(row?.action).toBe('privacy.history.delete');
    expect(row?.detail).toContain('1 events');
    // The ledger must not become a copy of the thing just erased.
    expect(row?.detail).not.toContain('A Very Private Song');
  });

  it('is a no-op with no history', async () => {
    expect(
      await (await makeApp('u1').request('/privacy/history', { method: 'DELETE' })).json(),
    ).toEqual({ deleted: 0 });
  });
});
