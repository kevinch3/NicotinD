/**
 * Route tests for on-demand BPM analysis + genre verification. Covers the
 * deterministic, no-ffmpeg paths: tag-first BPM, missing-file handling, the
 * genre suggestion via a stubbed Lidarr, and the admin-gated apply.
 */
import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { JwtPayload } from '@nicotind/core';
import type { Lidarr } from '@nicotind/lidarr-client';
import type { AuthEnv } from '../middleware/auth.js';
import type { AudioFeaturesClient } from '../services/audio-features-client.js';
import { applySchema } from '../db.js';
import { libraryRoutes } from './library.js';

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

function seedSong(db: Database, s: { id: string; bpm?: number; genre?: string }): void {
  db.run(
    `INSERT INTO library_songs
      (id, album_id, title, artist, artist_id, duration, genre, bpm, path,
       size, bit_rate, suffix, content_type, created, synced_at)
     VALUES (?, 'album-1', 'Avril 14th', 'Aphex Twin', 'artist-1', 120, ?, ?,
       'Aphex Twin/Drukqs/01 - Avril 14th.flac', 1000, 1000, 'flac', 'audio/flac', '2024-01-01', 0)`,
    [s.id, s.genre ?? null, s.bpm ?? null],
  );
}

const lidarr = {
  artist: {
    lookup: async () => [{ artistName: 'Aphex Twin', genres: ['Electronic', 'IDM'] }],
  },
} as unknown as Lidarr;

function makeApp(
  role: 'admin' | 'user' = 'admin',
  opts: { musicDir?: string; audioFeaturesClient?: AudioFeaturesClient | null } = {},
): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { sub: 'u1', role, iat: 0, exp: 0 } as JwtPayload);
    await next();
  });
  app.route(
    '/',
    libraryRoutes(opts.musicDir ?? '/music', {
      lidarr,
      audioFeaturesClient: opts.audioFeaturesClient ?? null,
    }),
  );
  return app;
}

describe('POST /songs/:id/analyze', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    applySchema(testDb);
  });
  afterEach(() => testDb.close());

  it('returns an existing bpm tag without analyzing', async () => {
    seedSong(testDb, { id: 'song-1', bpm: 128 });
    const res = await makeApp().request('/songs/song-1/analyze', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bpm: 128, source: 'tag', candidates: [128] });
  });

  it('404s for an unknown song', async () => {
    const res = await makeApp().request('/songs/nope/analyze', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('404s when the bpm is unknown and the file is missing', async () => {
    seedSong(testDb, { id: 'song-2' }); // no bpm, file not on disk under /music
    const res = await makeApp().request('/songs/song-2/analyze', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('uses the sidecar rhythm result (rounded) when a client is wired', async () => {
    const musicDir = mkdtempSync(join(tmpdir(), 'nicotind-analyze-'));
    try {
      mkdirSync(join(musicDir, 'Aphex Twin/Drukqs'), { recursive: true });
      writeFileSync(join(musicDir, 'Aphex Twin/Drukqs/01 - Avril 14th.flac'), 'fake');
      seedSong(testDb, { id: 'song-3' }); // no bpm; readAudioTags fails on fake bytes
      const calls: string[] = [];
      const client = {
        rhythm: async (relPath: string) => {
          calls.push(relPath);
          return { bpm: 141.9, confidence: 2.92 };
        },
      } as unknown as AudioFeaturesClient;
      const res = await makeApp('admin', { musicDir, audioFeaturesClient: client }).request(
        '/songs/song-3/analyze',
        { method: 'POST' },
      );
      expect(res.status).toBe(200);
      // The sidecar stub reports no candidates, so the route offers its own value.
      expect(await res.json()).toEqual({ bpm: 142, source: 'analyzed', candidates: [142] });
      expect(calls).toEqual(['Aphex Twin/Drukqs/01 - Avril 14th.flac']);
      const row = testDb
        .query<{ bpm: number }, [string]>('SELECT bpm FROM library_songs WHERE id = ?')
        .get('song-3');
      expect(row?.bpm).toBe(142);
    } finally {
      rmSync(musicDir, { recursive: true, force: true });
    }
  });

  // Issue #876: the drawer's button says "Re-analyze" once a value exists, but
  // the stored-value short-circuit made every click a no-op — the user could
  // never dislodge a wrong BPM (Bad Bunny "Un coco" stuck at 152).
  it('re-runs detection instead of echoing the stored bpm when forced', async () => {
    const musicDir = mkdtempSync(join(tmpdir(), 'nicotind-analyze-'));
    try {
      mkdirSync(join(musicDir, 'Aphex Twin/Drukqs'), { recursive: true });
      writeFileSync(join(musicDir, 'Aphex Twin/Drukqs/01 - Avril 14th.flac'), 'fake');
      seedSong(testDb, { id: 'song-4', bpm: 152 });
      const client = {
        rhythm: async () => ({ bpm: 152.0, confidence: 3.1, candidates: [152, 76] }),
      } as unknown as AudioFeaturesClient;
      const res = await makeApp('admin', { musicDir, audioFeaturesClient: client }).request(
        '/songs/song-4/analyze',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ force: true }),
        },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        bpm: 152,
        source: 'analyzed',
        candidates: [152, 76],
      });
    } finally {
      rmSync(musicDir, { recursive: true, force: true });
    }
  });

  it('still short-circuits on the stored bpm when not forced', async () => {
    seedSong(testDb, { id: 'song-5', bpm: 152 });
    const client = {
      rhythm: async () => {
        throw new Error('must not be called');
      },
    } as unknown as AudioFeaturesClient;
    const res = await makeApp('admin', { audioFeaturesClient: client }).request(
      '/songs/song-5/analyze',
      { method: 'POST' },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bpm: 152, source: 'tag', candidates: [152] });
  });

  // The tag is the other half of the short-circuit: a forced re-analysis that
  // read the file's own BPM frame back would return the same wrong number.
  it('ignores the file tag bpm when forced', async () => {
    const musicDir = mkdtempSync(join(tmpdir(), 'nicotind-analyze-'));
    try {
      mkdirSync(join(musicDir, 'Aphex Twin/Drukqs'), { recursive: true });
      writeFileSync(join(musicDir, 'Aphex Twin/Drukqs/01 - Avril 14th.flac'), 'fake');
      seedSong(testDb, { id: 'song-6' });
      const client = {
        rhythm: async () => ({ bpm: 88.2, confidence: 3.1, candidates: [88.2, 176.4] }),
      } as unknown as AudioFeaturesClient;
      const app = makeApp('admin', { musicDir, audioFeaturesClient: client });
      const res = await app.request('/songs/song-6/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      const body = (await res.json()) as { bpm: number; candidates: number[] };
      expect(body.bpm).toBe(88);
      expect(body.candidates).toEqual([88.2, 176.4]);
    } finally {
      rmSync(musicDir, { recursive: true, force: true });
    }
  });
});

describe('PUT /songs/:id/bpm', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    applySchema(testDb);
  });
  afterEach(() => testDb.close());

  it('persists a curator-chosen bpm to the database', async () => {
    const musicDir = mkdtempSync(join(tmpdir(), 'nicotind-analyze-'));
    try {
      mkdirSync(join(musicDir, 'Aphex Twin/Drukqs'), { recursive: true });
      writeFileSync(join(musicDir, 'Aphex Twin/Drukqs/01 - Avril 14th.flac'), 'fake');
      seedSong(testDb, { id: 'song-1', bpm: 152 });
      const res = await makeApp('admin', { musicDir }).request('/songs/song-1/bpm', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bpm: 76 }),
      });
      expect(res.status).toBe(200);
      const row = testDb
        .query<{ bpm: number }, [string]>('SELECT bpm FROM library_songs WHERE id = ?')
        .get('song-1');
      expect(row?.bpm).toBe(76);
    } finally {
      rmSync(musicDir, { recursive: true, force: true });
    }
  });

  it('rejects a non-curator', async () => {
    seedSong(testDb, { id: 'song-1', bpm: 152 });
    const res = await makeApp('user').request('/songs/song-1/bpm', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bpm: 76 }),
    });
    expect(res.status).toBe(403);
    const row = testDb
      .query<{ bpm: number }, [string]>('SELECT bpm FROM library_songs WHERE id = ?')
      .get('song-1');
    expect(row?.bpm).toBe(152);
  });

  it('rejects an implausible bpm', async () => {
    seedSong(testDb, { id: 'song-1', bpm: 152 });
    for (const bpm of [0, -5, 4000, Number.NaN]) {
      const res = await makeApp('admin').request('/songs/song-1/bpm', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bpm }),
      });
      expect(res.status).toBe(400);
    }
    const row = testDb
      .query<{ bpm: number }, [string]>('SELECT bpm FROM library_songs WHERE id = ?')
      .get('song-1');
    expect(row?.bpm).toBe(152);
  });

  it('404s for an unknown song', async () => {
    const res = await makeApp('admin').request('/songs/nope/bpm', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bpm: 76 }),
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /songs/:id/genre-suggestion', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    applySchema(testDb);
  });
  afterEach(() => testDb.close());

  it('returns current + suggested genre from lidarr', async () => {
    seedSong(testDb, { id: 'song-1', genre: 'IDM' });
    const res = await makeApp().request('/songs/song-1/genre-suggestion');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { current: string; suggested: string; source: string };
    expect(body.current).toBe('IDM');
    expect(body.suggested).toBe('Electronic');
    expect(body.source).toBe('lidarr');
  });
});

describe('POST /songs/:id/genre', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    applySchema(testDb);
  });
  afterEach(() => testDb.close());

  it('updates the genre for an admin', async () => {
    seedSong(testDb, { id: 'song-1', genre: 'IDM' });
    const res = await makeApp('admin').request('/songs/song-1/genre', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ genre: 'Electronic' }),
    });
    expect(res.status).toBe(200);
    const row = testDb
      .query<{ genre: string }, [string]>('SELECT genre FROM library_songs WHERE id = ?')
      .get('song-1');
    expect(row?.genre).toBe('Electronic');
  });

  it('rejects a non-admin', async () => {
    seedSong(testDb, { id: 'song-1', genre: 'IDM' });
    const res = await makeApp('user').request('/songs/song-1/genre', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ genre: 'Electronic' }),
    });
    expect(res.status).toBe(403);
  });

  // Issue #681: the artist-scoped sibling has always audited; this one silently
  // did not, so a curator's per-song genre edits left no trace at all.
  it('audit-logs the write, like its artist-scoped sibling', async () => {
    seedSong(testDb, { id: 'song-1', genre: 'IDM' });
    await makeApp('admin').request('/songs/song-1/genre', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ genre: 'Electronic' }),
    });
    const audit = testDb
      .query<{ action: string; target_id: string; detail: string }, []>(
        'SELECT action, target_id, detail FROM audit_log',
      )
      .all();
    const entry = audit.find((a) => a.action === 'song.genre');
    expect(entry?.target_id).toBe('song-1');
    expect(entry?.detail).toContain('Electronic');
  });

  it('404s for an unknown song instead of writing', async () => {
    const res = await makeApp('admin').request('/songs/nope/genre', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ genre: 'Electronic' }),
    });
    expect(res.status).toBe(404);
    expect(testDb.query('SELECT action FROM audit_log').all()).toHaveLength(0);
  });
});

// Issue #682: the write half of the curation review queue. Listing rides the
// shared ServiceReview snapshot, so there is no GET route to cover here.
describe('curation review flags', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    applySchema(testDb);
  });
  afterEach(() => testDb.close());

  const raise = (role: 'admin' | 'user', body: unknown) =>
    makeApp(role).request('/review-flags', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('raises a flag for a curator and audit-logs it', async () => {
    const res = await raise('admin', {
      targetKind: 'artist',
      targetId: 'Secret Cinema B2B Egbert',
      reason: 'two acts',
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { created: boolean }).toMatchObject({ ok: true, created: true });
    const audit = testDb
      .query<{ action: string }, []>('SELECT action FROM audit_log')
      .all()
      .map((a) => a.action);
    expect(audit).toContain('curation.flag');
  });

  it('rejects a bad target kind and a missing reason with 400', async () => {
    expect(
      (await raise('admin', { targetKind: 'playlist', targetId: 'p', reason: 'x' })).status,
    ).toBe(400);
    expect(
      (await raise('admin', { targetKind: 'artist', targetId: 'A', reason: '  ' })).status,
    ).toBe(400);
    expect(testDb.query('SELECT id FROM curation_flags').all()).toHaveLength(0);
  });

  it('rejects a non-curator', async () => {
    expect((await raise('user', { targetKind: 'artist', targetId: 'A', reason: 'x' })).status).toBe(
      403,
    );
  });

  it('resolves a flag once, then 404s (already handled reads the same as unknown)', async () => {
    await raise('admin', { targetKind: 'artist', targetId: 'A', reason: 'x' });
    const id = testDb.query<{ id: number }, []>('SELECT id FROM curation_flags').get()!.id;

    const first = await makeApp('admin').request(`/review-flags/${id}/resolve`, { method: 'POST' });
    expect(first.status).toBe(200);
    const second = await makeApp('admin').request(`/review-flags/${id}/resolve`, {
      method: 'POST',
    });
    expect(second.status).toBe(404);
    const unknown = await makeApp('admin').request('/review-flags/9999/resolve', {
      method: 'POST',
    });
    expect(unknown.status).toBe(404);
  });

  it('rejects a non-numeric flag id with 400', async () => {
    const res = await makeApp('admin').request('/review-flags/abc/resolve', { method: 'POST' });
    expect(res.status).toBe(400);
  });
});
