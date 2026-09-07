/**
 * Issue #987: a listener reports what is wrong with a track, and it reaches the
 * curation backlog — except for the one reason that is not about the track.
 */
import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { JwtPayload } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { applySchema } from '../db.js';
import { libraryRoutes } from './library.js';
import { listOpenCurationFlags } from '../services/curation-flags.js';

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

function appAs(sub: string, role = 'user'): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { sub, role, iat: 0, exp: 0 } as JwtPayload);
    await next();
  });
  app.route('/', libraryRoutes('/music', {}));
  return app;
}

const post = (sub: string, body: unknown, id = 'song-1') =>
  appAs(sub).request(`/songs/${id}/report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /songs/:id/report', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    applySchema(testDb);
    testDb.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, synced_at)
       VALUES ('song-1', 'alb', 'Antonia', 'Gondwana', 'art', 60, 'a/b.mp3', 1)`,
    );
  });

  it('files a listener report into the curation queue', async () => {
    const res = await post('u1', { reason: 'mistagged', note: 'year is wrong' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ routed: 'curation', flagged: true, counted: true });

    const flags = listOpenCurationFlags(testDb);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.reason).toBe('mistagged: year is wrong');
    expect(flags[0]!.source).toBe('listener');
  });

  /**
   * The one reason that must not reach curation: nothing is wrong with the
   * track, so filing it would put an item on the worklist no curator can ever
   * action. The recommender already models this signal.
   */
  it('routes "I do not like it" to taste, creating no flag', async () => {
    const res = await post('u1', { reason: 'not_for_me' });
    expect(await res.json()).toEqual({ routed: 'taste', flagged: false });
    expect(listOpenCurationFlags(testDb)).toHaveLength(0);
  });

  it('rejects an unknown reason rather than filing a vague one', async () => {
    const res = await post('u1', { reason: 'bad' });
    expect(res.status).toBe(400);
    expect(listOpenCurationFlags(testDb)).toHaveLength(0);
  });

  it('404s an unknown song', async () => {
    expect((await post('u1', { reason: 'quality' }, 'nope')).status).toBe(404);
  });

  it('counts a second reporter, and does not count the same one twice', async () => {
    await post('u1', { reason: 'quality' });
    expect(await (await post('u2', { reason: 'misnamed' })).json()).toMatchObject({
      reportCount: 2,
      counted: true,
    });
    expect(await (await post('u1', { reason: 'misnamed' })).json()).toMatchObject({
      reportCount: 2,
      counted: false,
    });
  });

  it('caps an over-long note rather than storing it whole', async () => {
    await post('u1', { reason: 'other', note: 'x'.repeat(5000) });
    const row = testDb.query<{ note: string }, []>(`SELECT note FROM curation_flag_reports`).get()!;
    expect(row.note.length).toBeLessThanOrEqual(500);
  });
});
