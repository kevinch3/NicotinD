/**
 * Route tests for the download-review triage surface (issue #411): the
 * curator-gated queue/count/approve/discard endpoints backing the inbox.
 */
import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { JwtPayload } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { applySchema } from '../db.js';
import { downloadReviewRoutes } from './download-review.js';
import { ShareRescanScheduler } from '../services/share-rescan-scheduler.js';

function noopScheduler(): ShareRescanScheduler {
  return new ShareRescanScheduler(async () => {});
}

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

function authed(app: Hono<AuthEnv>, role: 'refiner' | 'user' = 'refiner'): Hono<AuthEnv> {
  const wrap = new Hono<AuthEnv>();
  wrap.use('*', async (c, next) => {
    c.set('user', { sub: 'u1', username: 'curator', role, iat: 0, exp: 0 } as JwtPayload);
    await next();
  });
  wrap.route('/', app);
  return wrap;
}

function seedAlbum(albumId: string, songId: string): void {
  testDb.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
     VALUES (?, 'Album', 'Artist', 'art', 1, 0, 1)`,
    [albumId],
  );
  testDb.run(
    `INSERT INTO library_songs
       (id, album_id, title, artist, artist_id, duration, path, size, created, synced_at)
     VALUES (?, ?, 'T', 'Artist', 'art', 0, ?, 10, '2024-01-01', 1)`,
    [songId, albumId, `${songId}.opus`],
  );
}

beforeEach(() => {
  testDb = new Database(':memory:');
  applySchema(testDb);
});

describe('download-review routes', () => {
  it('403s a non-curator', async () => {
    const app = authed(
      new Hono<AuthEnv>().route('/', downloadReviewRoutes({ shareRescan: noopScheduler() })),
      'user',
    );
    const res = await app.request('/queue');
    expect(res.status).toBe(403);
  });

  it('lists pending albums in the queue and count', async () => {
    seedAlbum('al1', 's1');
    seedAlbum('al2', 's2');
    const app = authed(
      new Hono<AuthEnv>().route('/', downloadReviewRoutes({ shareRescan: noopScheduler() })),
    );

    const queueRes = await app.request('/queue');
    expect(queueRes.status).toBe(200);
    const queueBody = (await queueRes.json()) as { albums: { albumId: string }[] };
    expect(queueBody.albums).toHaveLength(2);

    const countRes = await app.request('/count');
    expect(countRes.status).toBe(200);
    expect((await countRes.json()) as { pending: number }).toEqual({ pending: 2 });
  });

  it('approve records a decision, audits, and kicks the processor', async () => {
    seedAlbum('al1', 's1');
    const kickEager = mock(() => Promise.resolve());
    const app = authed(
      new Hono<AuthEnv>().route(
        '/',
        downloadReviewRoutes({ shareRescan: noopScheduler(), kickEager }),
      ),
    );

    const res = await app.request('/albums/al1/approve', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const row = testDb
      .query('SELECT state FROM download_reviews WHERE album_id = ?')
      .get('al1') as { state: string } | null;
    expect(row?.state).toBe('approved');

    const audit = testDb
      .query("SELECT action FROM audit_log WHERE action = 'download_review.approve'")
      .get() as { action: string } | null;
    expect(audit?.action).toBe('download_review.approve');

    expect(kickEager).toHaveBeenCalledTimes(1);
  });

  it('approve is idempotent', async () => {
    seedAlbum('al1', 's1');
    const app = authed(
      new Hono<AuthEnv>().route('/', downloadReviewRoutes({ shareRescan: noopScheduler() })),
    );

    expect((await app.request('/albums/al1/approve', { method: 'POST' })).status).toBe(200);
    expect((await app.request('/albums/al1/approve', { method: 'POST' })).status).toBe(200);

    const rows = testDb
      .query('SELECT COUNT(*) as c FROM download_reviews WHERE album_id = ?')
      .get('al1') as { c: number };
    expect(rows.c).toBe(1);
  });

  it('discard deletes the album and records the decision', async () => {
    seedAlbum('al1', 's1');
    const app = authed(
      new Hono<AuthEnv>().route(
        '/',
        downloadReviewRoutes({
          musicDir: '/tmp/nicotind-test-music',
          shareRescan: noopScheduler(),
        }),
      ),
    );

    const res = await app.request('/albums/al1/discard', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; deletedCount: number };
    expect(body.ok).toBe(true);
    expect(body.deletedCount).toBe(1);

    const songs = testDb.query('SELECT id FROM library_songs WHERE album_id = ?').all('al1');
    expect(songs).toHaveLength(0);

    const decision = testDb
      .query('SELECT state FROM download_reviews WHERE album_id = ?')
      .get('al1') as { state: string } | null;
    expect(decision?.state).toBe('discarded');

    const audit = testDb
      .query("SELECT action FROM audit_log WHERE action = 'download_review.discard'")
      .get() as { action: string } | null;
    expect(audit?.action).toBe('download_review.discard');
  });

  it('discard 404s an unknown album', async () => {
    const app = authed(
      new Hono<AuthEnv>().route('/', downloadReviewRoutes({ shareRescan: noopScheduler() })),
    );
    const res = await app.request('/albums/nope/discard', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});
