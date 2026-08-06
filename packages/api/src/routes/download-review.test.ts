/**
 * Route tests for the download-review triage surface (issue #411): the
 * curator-gated queue/count/approve/discard endpoints backing the inbox, plus
 * (task 9) per-track identify + retag-and-rescan.
 */
import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { JwtPayload, IdentifyOutcome, IdentifyResult } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { applySchema } from '../db.js';
import { downloadReviewRoutes, voteAlbumIdentity } from './download-review.js';
import { ShareRescanScheduler } from '../services/share-rescan-scheduler.js';
import type { PluginRegistry } from '../services/plugins/registry.js';
import { setProcessingSettings } from '../services/processing-settings.js';
import { armReviewHold } from '../services/download-review-store.js';

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
    armReviewHold(testDb); // established library — bootstrap exemption already cleared
    setProcessingSettings(testDb, { holdForReview: true });
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

  it('with holdForReview off (the default), queue/count read as empty even with quarantined albums', async () => {
    seedAlbum('al1', 's1');
    seedAlbum('al2', 's2');
    const app = authed(
      new Hono<AuthEnv>().route('/', downloadReviewRoutes({ shareRescan: noopScheduler() })),
    );

    const queueRes = await app.request('/queue');
    expect(queueRes.status).toBe(200);
    expect(await queueRes.json()).toEqual({ albums: [] });

    const countRes = await app.request('/count');
    expect(countRes.status).toBe(200);
    expect(await countRes.json()).toEqual({ pending: 0 });
  });

  it('with holdForReview on, queue/count report the pending albums as before', async () => {
    armReviewHold(testDb);
    setProcessingSettings(testDb, { holdForReview: true });
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

  it('with holdForReview on but the bootstrap marker unarmed, queue/count read as empty', async () => {
    // No armReviewHold — a fresh library that hasn't finished its first
    // bootstrap drain must not surface a review inbox (issue #417).
    setProcessingSettings(testDb, { holdForReview: true });
    seedAlbum('al1', 's1');
    const app = authed(
      new Hono<AuthEnv>().route('/', downloadReviewRoutes({ shareRescan: noopScheduler() })),
    );

    const queueRes = await app.request('/queue');
    expect(queueRes.status).toBe(200);
    expect(await queueRes.json()).toEqual({ albums: [] });

    const countRes = await app.request('/count');
    expect(countRes.status).toBe(200);
    expect(await countRes.json()).toEqual({ pending: 0 });
  });
});

describe('voteAlbumIdentity', () => {
  function hit(artist: string, album: string): IdentifyResult {
    return { acoustId: `${artist}-${album}`, score: 0.9, artist, album };
  }

  it('3 agreeing results vote for the shared artist/album', () => {
    const vote = voteAlbumIdentity([
      hit('Bad Bunny', 'YHLQMDLG'),
      hit('Bad Bunny', 'YHLQMDLG'),
      hit('Bad Bunny', 'YHLQMDLG'),
    ]);
    expect(vote).toEqual({ artist: 'Bad Bunny', album: 'YHLQMDLG', votes: 3, total: 3 });
  });

  it('a 1-1 split has no majority winner', () => {
    const vote = voteAlbumIdentity([hit('Artist A', 'Album A'), hit('Artist B', 'Album B')]);
    expect(vote).toBeNull();
  });

  it('all-null results vote for nothing', () => {
    expect(voteAlbumIdentity([null, null, null])).toBeNull();
  });

  it('2 of 3 agreeing is a majority', () => {
    const vote = voteAlbumIdentity([
      hit('Artist A', 'Album A'),
      hit('Artist A', 'Album A'),
      hit('Artist B', 'Album B'),
    ]);
    expect(vote).toEqual({ artist: 'Artist A', album: 'Album A', votes: 2, total: 3 });
  });
});

describe('download-review identify + retag routes', () => {
  /** A registry stub exposing only the `identify` capability. */
  function makeIdentifyRegistry(
    fn: (abs: string) => Promise<IdentifyResult | null>,
    detailed?: (abs: string) => Promise<IdentifyOutcome>,
  ): PluginRegistry {
    const plugin = {
      identify: detailed
        ? { identifyTrack: fn, identifyTrackDetailed: detailed }
        : { identifyTrack: fn },
    };
    return {
      getEnabledWithCapability: (cap: string) => (cap === 'identify' ? [plugin] : []),
    } as unknown as PluginRegistry;
  }

  function noIdentifyRegistry(): PluginRegistry {
    return { getEnabledWithCapability: () => [] } as unknown as PluginRegistry;
  }

  function seedSongWithFile(
    musicDir: string,
    albumId: string,
    songId: string,
    relPath: string,
  ): void {
    const abs = join(musicDir, relPath);
    writeFileSync(abs, 'x');
    testDb.run(
      `INSERT INTO library_songs
         (id, album_id, title, artist, artist_id, duration, path, size, created, synced_at)
       VALUES (?, ?, 'T', 'Artist', 'art', 0, ?, 1, '2024-01-01', 1)`,
      [songId, albumId, relPath],
    );
  }

  function ensureAlbum(albumId: string): void {
    testDb.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
       VALUES (?, 'Album', 'Artist', 'art', 1, 0, 1)`,
      [albumId],
    );
  }

  it('identify: 200 with the mapped result from the enabled plugin', async () => {
    ensureAlbum('al1');
    const musicDir = mkdtempSync(join(tmpdir(), 'nicotind-review-'));
    seedSongWithFile(musicDir, 'al1', 's1', 's1.mp3');
    const result: IdentifyResult = { acoustId: 'abc', score: 0.95, artist: 'X', album: 'Y' };
    const app = authed(
      new Hono<AuthEnv>().route(
        '/',
        downloadReviewRoutes({
          musicDir,
          shareRescan: noopScheduler(),
          plugins: makeIdentifyRegistry(async () => result),
        }),
      ),
    );

    const res = await app.request('/songs/s1/identify', { method: 'POST' });
    expect(res.status).toBe(200);
    // `result` is unchanged for existing callers; `outcome` is the #414 addition.
    expect(await res.json()).toEqual({ result, outcome: { kind: 'match', result } });
  });

  // Issue #414: a plugin that can explain itself must have that explanation
  // reach the client, and one that can't must still behave as before.
  it('identify: passes a typed failure outcome through to the client', async () => {
    ensureAlbum('al1');
    const musicDir = mkdtempSync(join(tmpdir(), 'nicotind-review-'));
    seedSongWithFile(musicDir, 'al1', 's1', 's1.mp3');
    const app = authed(
      new Hono<AuthEnv>().route(
        '/',
        downloadReviewRoutes({
          musicDir,
          shareRescan: noopScheduler(),
          plugins: makeIdentifyRegistry(
            async () => null,
            async () => ({ kind: 'undecodable', detail: 'ERROR: invalid data found' }),
          ),
        }),
      ),
    );

    const res = await app.request('/songs/s1/identify', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      result: null,
      outcome: { kind: 'undecodable', detail: 'ERROR: invalid data found' },
    });
  });

  it('identify: falls back to no-match for a plugin without the detailed variant', async () => {
    ensureAlbum('al1');
    const musicDir = mkdtempSync(join(tmpdir(), 'nicotind-review-'));
    seedSongWithFile(musicDir, 'al1', 's1', 's1.mp3');
    const app = authed(
      new Hono<AuthEnv>().route(
        '/',
        downloadReviewRoutes({
          musicDir,
          shareRescan: noopScheduler(),
          plugins: makeIdentifyRegistry(async () => null),
        }),
      ),
    );

    const res = await app.request('/songs/s1/identify', { method: 'POST' });
    expect(await res.json()).toEqual({ result: null, outcome: { kind: 'no-match' } });
  });

  it('identify album: a song whose file vanished reports file-missing, not no-match', async () => {
    ensureAlbum('al2');
    const musicDir = mkdtempSync(join(tmpdir(), 'nicotind-review-'));
    // Row points at a path that was never written to disk.
    testDb.run(
      `INSERT INTO library_songs
         (id, album_id, title, artist, artist_id, duration, path, size, created, synced_at)
       VALUES ('gone', 'al2', 'T', 'Artist', 'art', 0, 'gone.mp3', 1, '2024-01-01', 1)`,
    );
    const app = authed(
      new Hono<AuthEnv>().route(
        '/',
        downloadReviewRoutes({
          musicDir,
          shareRescan: noopScheduler(),
          plugins: makeIdentifyRegistry(async () => null),
        }),
      ),
    );

    const res = await app.request('/albums/al2/identify', { method: 'POST' });
    const body = (await res.json()) as {
      perTrack: Array<{ songId: string; result: IdentifyResult | null; outcome: { kind: string } }>;
    };
    expect(body.perTrack).toEqual([
      { songId: 'gone', result: null, outcome: { kind: 'file-missing' } },
    ]);
  });

  it('identify: 503 when no identify plugin is enabled', async () => {
    ensureAlbum('al1');
    const musicDir = mkdtempSync(join(tmpdir(), 'nicotind-review-'));
    seedSongWithFile(musicDir, 'al1', 's1', 's1.mp3');
    const app = authed(
      new Hono<AuthEnv>().route(
        '/',
        downloadReviewRoutes({
          musicDir,
          shareRescan: noopScheduler(),
          plugins: noIdentifyRegistry(),
        }),
      ),
    );

    const res = await app.request('/songs/s1/identify', { method: 'POST' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'AcoustID not available' });
  });

  it('identify: 404s an unknown song', async () => {
    const app = authed(
      new Hono<AuthEnv>().route(
        '/',
        downloadReviewRoutes({
          shareRescan: noopScheduler(),
          plugins: makeIdentifyRegistry(async () => null),
        }),
      ),
    );

    const res = await app.request('/songs/nope/identify', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('retag: writes tags, rescans once with both rel paths, and audits', async () => {
    ensureAlbum('al1');
    const musicDir = mkdtempSync(join(tmpdir(), 'nicotind-review-'));
    seedSongWithFile(musicDir, 'al1', 's1', 's1.mp3');
    seedSongWithFile(musicDir, 'al1', 's2', 's2.mp3');
    const writeTags = mock(async () => true);
    const scanIncremental = mock(async () => {});
    const app = authed(
      new Hono<AuthEnv>().route(
        '/',
        downloadReviewRoutes({
          musicDir,
          shareRescan: noopScheduler(),
          writeTags,
          scanIncremental,
        }),
      ),
    );

    const res = await app.request('/albums/al1/tracks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tracks: [
          { id: 's1', title: 'Song One', artist: 'Artist One' },
          { id: 's2', title: 'Song Two' },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { updated: number; failed: unknown[]; rescanned: boolean };
    expect(body.updated).toBe(2);
    expect(body.failed).toEqual([]);
    expect(body.rescanned).toBe(true);

    expect(writeTags).toHaveBeenCalledTimes(2);
    expect(scanIncremental).toHaveBeenCalledTimes(1);
    const [rescannedPaths] = scanIncremental.mock.calls[0] as unknown as [string[]];
    expect(rescannedPaths.sort()).toEqual(['s1.mp3', 's2.mp3']);

    const audit = testDb
      .query("SELECT action, target_id FROM audit_log WHERE action = 'download_review.retag'")
      .get() as { action: string; target_id: string } | null;
    expect(audit?.action).toBe('download_review.retag');
    expect(audit?.target_id).toBe('al1');
  });

  it('retag: an unknown song id lands in failed while the known one still updates', async () => {
    ensureAlbum('al1');
    const musicDir = mkdtempSync(join(tmpdir(), 'nicotind-review-'));
    seedSongWithFile(musicDir, 'al1', 's1', 's1.mp3');
    const writeTags = mock(async () => true);
    const app = authed(
      new Hono<AuthEnv>().route(
        '/',
        downloadReviewRoutes({ musicDir, shareRescan: noopScheduler(), writeTags }),
      ),
    );

    const res = await app.request('/albums/al1/tracks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tracks: [
          { id: 's1', title: 'Song One' },
          { id: 'nope', title: 'Ghost' },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      updated: number;
      failed: Array<{ id: string; error: string }>;
    };
    expect(body.updated).toBe(1);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0]?.id).toBe('nope');
    expect(writeTags).toHaveBeenCalledTimes(1);
  });

  it('retag: a track with no title/artist fields fails without a silent no-op success', async () => {
    ensureAlbum('al1');
    const musicDir = mkdtempSync(join(tmpdir(), 'nicotind-review-'));
    seedSongWithFile(musicDir, 'al1', 's1', 's1.mp3');
    const writeTags = mock(async () => true);
    const scanIncremental = mock(async () => {});
    const app = authed(
      new Hono<AuthEnv>().route(
        '/',
        downloadReviewRoutes({
          musicDir,
          shareRescan: noopScheduler(),
          writeTags,
          scanIncremental,
        }),
      ),
    );

    const res = await app.request('/albums/al1/tracks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tracks: [{ id: 's1' }] }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      updated: number;
      failed: Array<{ id: string; error: string }>;
      rescanned: boolean;
    };
    expect(body.updated).toBe(0);
    expect(body.failed).toEqual([{ id: 's1', error: 'No fields to update' }]);
    expect(body.rescanned).toBe(false);
    expect(writeTags).not.toHaveBeenCalled();
    expect(scanIncremental).not.toHaveBeenCalled();
  });

  it('retag: a landed song id (post-quarantine) fails, and its file is left untouched', async () => {
    ensureAlbum('al1');
    const musicDir = mkdtempSync(join(tmpdir(), 'nicotind-review-'));
    seedSongWithFile(musicDir, 'al1', 's1', 's1.mp3');
    testDb.run(`UPDATE library_songs SET landed_at = '2024-01-02' WHERE id = 's1'`);
    const writeTags = mock(async () => true);
    const app = authed(
      new Hono<AuthEnv>().route(
        '/',
        downloadReviewRoutes({ musicDir, shareRescan: noopScheduler(), writeTags }),
      ),
    );

    const res = await app.request('/albums/al1/tracks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tracks: [{ id: 's1', title: 'Should Not Land' }] }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      updated: number;
      failed: Array<{ id: string; error: string }>;
    };
    expect(body.updated).toBe(0);
    expect(body.failed).toEqual([{ id: 's1', error: 'Not a quarantined track of this album' }]);
    expect(writeTags).not.toHaveBeenCalled();
  });

  it('retag: a track belonging to a different album fails without calling writeTags', async () => {
    ensureAlbum('al1');
    ensureAlbum('al2');
    const musicDir = mkdtempSync(join(tmpdir(), 'nicotind-review-'));
    seedSongWithFile(musicDir, 'al2', 's1', 's1.mp3');
    const writeTags = mock(async () => true);
    const app = authed(
      new Hono<AuthEnv>().route(
        '/',
        downloadReviewRoutes({ musicDir, shareRescan: noopScheduler(), writeTags }),
      ),
    );

    // s1 actually belongs to al2 — hitting al1's tracks route for it must fail.
    const res = await app.request('/albums/al1/tracks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tracks: [{ id: 's1', title: 'Wrong Album' }] }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      updated: number;
      failed: Array<{ id: string; error: string }>;
    };
    expect(body.updated).toBe(0);
    expect(body.failed).toEqual([{ id: 's1', error: 'Not a quarantined track of this album' }]);
    expect(writeTags).not.toHaveBeenCalled();
  });

  it('retag: an all-failed request (0 updated) records no audit entry', async () => {
    ensureAlbum('al1');
    const musicDir = mkdtempSync(join(tmpdir(), 'nicotind-review-'));
    seedSongWithFile(musicDir, 'al1', 's1', 's1.mp3');
    const writeTags = mock(async () => true);
    const app = authed(
      new Hono<AuthEnv>().route(
        '/',
        downloadReviewRoutes({ musicDir, shareRescan: noopScheduler(), writeTags }),
      ),
    );

    const res = await app.request('/albums/al1/tracks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tracks: [{ id: 's1' }] }),
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { updated: number }).updated).toBe(0);

    const audit = testDb
      .query("SELECT action FROM audit_log WHERE action = 'download_review.retag'")
      .get() as { action: string } | null;
    expect(audit).toBeNull();
  });

  it('retag: a path escaping the music dir fails without calling writeTags', async () => {
    ensureAlbum('al1');
    const musicDir = mkdtempSync(join(tmpdir(), 'nicotind-review-'));
    testDb.run(
      `INSERT INTO library_songs
         (id, album_id, title, artist, artist_id, duration, path, size, created, synced_at)
       VALUES ('s1', 'al1', 'T', 'Artist', 'art', 0, '../evil.mp3', 1, '2024-01-01', 1)`,
    );
    const writeTags = mock(async () => true);
    const app = authed(
      new Hono<AuthEnv>().route(
        '/',
        downloadReviewRoutes({ musicDir, shareRescan: noopScheduler(), writeTags }),
      ),
    );

    const res = await app.request('/albums/al1/tracks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tracks: [{ id: 's1', title: 'Evil' }] }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      updated: number;
      failed: Array<{ id: string; error: string }>;
    };
    expect(body.updated).toBe(0);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0]?.id).toBe('s1');
    expect(writeTags).not.toHaveBeenCalled();
  });
});
