/**
 * Route tests for the listening-history endpoints. The property worth pinning
 * here is privacy: both routes derive the user from the auth context and take
 * no user id, so one caller can never reach another's history.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { AuthEnv } from '../middleware/auth.js';
import { applySchema } from '../db.js';
import { historyRoutes } from './history.js';

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

function makeApp(userId: string) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { sub: userId } as AuthEnv['Variables']['user']);
    await next();
  });
  app.route('/', historyRoutes());
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
    source: 'album',
    device: 'browser',
    title: 'Track',
    artist: 'Artist',
    album: 'Album',
    ...over,
  };
}

/** GET /recent as u1, parsed. */
async function recent(path = '/recent'): Promise<Array<{ songId: string }>> {
  const res = await makeApp('u1').request(path);
  expect(res.status).toBe(200);
  return (await res.json()) as Array<{ songId: string }>;
}

function post(app: Hono<AuthEnv>, events: unknown) {
  return app.request('/plays', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events }),
  });
}

beforeEach(() => {
  testDb = new Database(':memory:');
  applySchema(testDb);
  testDb.run(
    "INSERT INTO users (id, username, password_hash) VALUES ('u1', 'a', 'x'), ('u2', 'b', 'y')",
  );
  testDb.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at, hidden)
     VALUES ('al', 'Album', 'Artist', 'art', 1, 0, 1, 0)`,
  );
  // /recent joins the live library, so the played songs must actually exist.
  for (const id of ['s1', 's2', 'a', 'b', 'mine', 's0', 's3', 's4']) {
    testDb.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size,
                                  created, synced_at, hidden, landed_at)
       VALUES (?, 'al', ?, 'Artist', 'art', 180, ?, 100, '2024-01-01', 1, 0, 1)`,
      [id, id, `Artist/Album/${id}.opus`],
    );
  }
});

describe('POST /plays', () => {
  it('records a batch and reports what it did', async () => {
    const res = await post(makeApp('u1'), [event(), event({ songId: 's2' })]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inserted: 2, duplicates: 0, rejected: 0 });
  });

  it('is idempotent, so an offline flush can retry safely', async () => {
    const app = makeApp('u1');
    const e = event();
    await post(app, [e]);
    const res = await post(app, [e]);
    expect(await res.json()).toMatchObject({ inserted: 0, duplicates: 1 });
  });

  it('400s when events is not an array', async () => {
    const res = await post(makeApp('u1'), { nope: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('400s on an empty body rather than throwing', async () => {
    const res = await makeApp('u1').request('/plays', { method: 'POST' });
    expect(res.status).toBe(400);
  });

  it('attributes the play to the authenticated caller, not the payload', async () => {
    await post(makeApp('u2'), [event({ userId: 'u1' })]);
    const row = testDb.query<{ user_id: string }, []>(`SELECT user_id FROM play_events`).get();
    expect(row?.user_id).toBe('u2');
  });
});

describe('GET /recent', () => {
  it('returns the caller’s recent plays, newest first', async () => {
    await post(makeApp('u1'), [
      event({ songId: 'a', startedAt: 1_000, title: 'A' }),
      event({ songId: 'b', startedAt: 2_000, title: 'B' }),
    ]);

    const res = await makeApp('u1').request('/recent');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ songId: string }>;
    expect(body.map((r) => r.songId)).toEqual(['b', 'a']);
  });

  it('ships the live cover-art id so the shelf can render real covers', async () => {
    testDb.run(`UPDATE library_songs SET cover_art = 'cov-a' WHERE id = 'a'`);
    testDb.run(`UPDATE library_albums SET cover_art = 'cov-al' WHERE id = 'al'`);
    await post(makeApp('u1'), [
      event({ songId: 'a', startedAt: 1_000 }),
      event({ songId: 'b', startedAt: 2_000 }),
    ]);

    const res = await makeApp('u1').request('/recent');
    const body = (await res.json()) as Array<{ songId: string; coverArt: string | null }>;
    expect(body.find((r) => r.songId === 'a')?.coverArt).toBe('cov-a');
    // No song-level cover id → the album's, matching every other song listing.
    expect(body.find((r) => r.songId === 'b')?.coverArt).toBe('cov-al');
  });

  it('falls back to the album id when neither song nor album carry a cover id', async () => {
    await post(makeApp('u1'), [event({ songId: 'a' })]);
    const res = await makeApp('u1').request('/recent');
    const body = (await res.json()) as Array<{ coverArt: string | null }>;
    // The cover route resolves entity ids to folder/embedded art, so the album
    // id is a servable last resort rather than a guaranteed 404.
    expect(body[0]?.coverArt).toBe('al');
  });

  it('never returns another user’s history', async () => {
    await post(makeApp('u1'), [event({ songId: 'mine' })]);
    const res = await makeApp('u2').request('/recent');
    expect(await res.json()).toEqual([]);
  });

  it('honours limit and clamps a hostile one', async () => {
    await post(
      makeApp('u1'),
      Array.from({ length: 5 }, (_, i) => event({ songId: `s${i}`, startedAt: 1_000 + i })),
    );
    expect(await recent('/recent?limit=2')).toHaveLength(2);
    // Not a crash and not 5000 rows.
    expect(await recent('/recent?limit=99999')).toHaveLength(5);
  });

  it('ignores a non-numeric limit', async () => {
    await post(makeApp('u1'), [event()]);
    expect(await recent('/recent?limit=abc')).toHaveLength(1);
  });
});

describe('GET /stats', () => {
  it('returns aggregates for the caller', async () => {
    await post(makeApp('u1'), [event({ songId: 's1' }), event({ songId: 's1' })]);

    const res = await makeApp('u1').request('/stats?period=all');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      period: string;
      totals: { plays: number };
      topSongs: Array<{ songId: string }>;
      clock: number[];
    };
    expect(body.period).toBe('all');
    expect(body.totals.plays).toBe(2);
    expect(body.topSongs[0]).toMatchObject({ songId: 's1', plays: 2 });
    expect(body.clock).toHaveLength(24);
  });

  it('falls back to the default period instead of 400ing on a typo', async () => {
    const res = await makeApp('u1').request('/stats?period=nonsense');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ period: '30d' });
  });

  it('defaults the period when none is given', async () => {
    expect(await (await makeApp('u1').request('/stats')).json()).toMatchObject({ period: '30d' });
  });

  it('never reports another user\u2019s listening', async () => {
    await post(makeApp('u1'), [event({ songId: 's1' })]);
    const body = (await (await makeApp('u2').request('/stats?period=all')).json()) as {
      totals: { plays: number };
    };
    expect(body.totals.plays).toBe(0);
  });
});
