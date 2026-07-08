/**
 * Route tests for the cover picker: candidate aggregation (current + deduped
 * Lidarr alternatives), admin gating, and cover-only apply by URL. The
 * songId/embedded-art happy path needs a real file with embedded art, so it's
 * covered at the service level (cover-sources.test.ts); here we assert the
 * deterministic DB/HTTP behavior.
 */
import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { JwtPayload } from '@nicotind/core';
import type { Lidarr } from '@nicotind/lidarr-client';
import type { AuthEnv } from '../middleware/auth.js';
import { applySchema } from '../db.js';
import { libraryRoutes } from './library.js';
import { streamingRoutes, clearCoverNegativeCache } from './streaming.js';

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

function seedAlbum(db: Database): void {
  db.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, cover_art, song_count, duration, year, synced_at)
     VALUES ('album-1', 'Drukqs', 'Aphex Twin', 'artist-1', 'album-1', 1, 120, 2001, 0)`,
  );
  db.run(
    `INSERT INTO library_songs
      (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, synced_at)
     VALUES ('song-1', 'album-1', 'Avril 14th', 'Aphex Twin', 'artist-1', 120,
       'Aphex Twin/Drukqs/01 - Avril 14th.flac', 1000, 1000, 'flac', 'audio/flac', '2024-01-01', 0)`,
  );
}

// Two lookup hits sharing one cover URL → deduped to a single Lidarr option.
const lidarr = {
  album: {
    lookup: async () => [
      {
        foreignAlbumId: 'rg1',
        title: 'Drukqs',
        releaseDate: '2001-10-22',
        albumType: 'Album',
        artist: { artistName: 'Aphex Twin' },
        images: [{ coverType: 'cover', remoteUrl: 'https://img/drukqs.jpg' }],
      },
      {
        foreignAlbumId: 'rg2',
        title: 'Drukqs (Reissue)',
        releaseDate: '2010-01-01',
        albumType: 'Album',
        artist: { artistName: 'Aphex Twin' },
        images: [{ coverType: 'cover', remoteUrl: 'https://img/drukqs.jpg' }],
      },
      {
        foreignAlbumId: 'rg3',
        title: 'Selected Ambient Works',
        releaseDate: '1992-01-01',
        albumType: 'Album',
        artist: { artistName: 'Aphex Twin' },
        images: [{ coverType: 'cover', remoteUrl: 'https://img/saw.jpg' }],
      },
    ],
  },
} as unknown as Lidarr;

function makeApp(role: 'admin' | 'user' = 'admin', withLidarr = true): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { sub: 'u1', role, iat: 0, exp: 0 } as JwtPayload);
    await next();
  });
  app.route('/', libraryRoutes('/music', { lidarr: withLidarr ? lidarr : null }));
  return app;
}

describe('GET /albums/:id/cover-candidates', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    applySchema(testDb);
  });
  afterEach(() => testDb.close());

  it('returns the current cover + deduped Lidarr alternatives', async () => {
    seedAlbum(testDb);
    const res = await makeApp().request('/albums/album-1/cover-candidates');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      current: { source: string; url: string; label: string };
      lidarr: { url: string; label: string }[];
      files: unknown[];
    };
    expect(body.current).toEqual({
      source: 'current',
      url: '/api/cover/album-1',
      label: 'Current',
    });
    // Two hits share https://img/drukqs.jpg → one entry; SAW is the second.
    expect(body.lidarr.map((l) => l.url)).toEqual(['https://img/drukqs.jpg', 'https://img/saw.jpg']);
    expect(body.lidarr[0].label).toContain('Drukqs');
    // No real files on disk under /music → no embedded-file candidates.
    expect(body.files).toEqual([]);
  });

  it('omits Lidarr covers (not a 503) when Lidarr is unconfigured', async () => {
    seedAlbum(testDb);
    const res = await makeApp('admin', false).request('/albums/album-1/cover-candidates');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lidarr: unknown[] };
    expect(body.lidarr).toEqual([]);
  });

  it('404s for an unknown album', async () => {
    const res = await makeApp().request('/albums/nope/cover-candidates');
    expect(res.status).toBe(404);
  });

  it('rejects a non-admin', async () => {
    seedAlbum(testDb);
    const res = await makeApp('user').request('/albums/album-1/cover-candidates');
    expect(res.status).toBe(403);
  });
});

describe('POST /albums/:id/cover', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    applySchema(testDb);
  });
  afterEach(() => testDb.close());

  it('sets a canonical cover from a URL', async () => {
    seedAlbum(testDb);
    const res = await makeApp().request('/albums/album-1/cover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ coverUrl: 'https://img/new.jpg' }),
    });
    expect(res.status).toBe(200);
    const row = testDb
      .query<{ cover_url: string }, [string]>('SELECT cover_url FROM library_artwork WHERE id = ?')
      .get('album-1');
    expect(row?.cover_url).toBe('https://img/new.jpg');
  });

  it('400s when neither coverUrl nor songId is provided', async () => {
    seedAlbum(testDb);
    const res = await makeApp().request('/albums/album-1/cover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('404s when the songId is not in the album', async () => {
    seedAlbum(testDb);
    const res = await makeApp().request('/albums/album-1/cover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ songId: 'not-in-album' }),
    });
    expect(res.status).toBe(404);
  });

  it('rejects a non-admin', async () => {
    seedAlbum(testDb);
    const res = await makeApp('user').request('/albums/album-1/cover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ coverUrl: 'https://img/new.jpg' }),
    });
    expect(res.status).toBe(403);
  });
});

// Regression: an album that was previously artless gets its id memoized in the
// streaming route's negative-art cache (`noArtCache`, 10-minute TTL) the first
// time `/api/cover/:id` 404s. Applying a new cover writes `library_artwork`/the
// folder file successfully (200 `{ok:true}`), but every `/api/cover/:id` request
// afterwards — including a plain page refresh — must stop hitting that stale
// cached 404 immediately, not after the TTL expires.
describe('POST /albums/:id/cover — cover route reflects the change immediately', () => {
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const realFetch = globalThis.fetch;
  let dataDir: string;

  function makeCombinedApp(): Hono<AuthEnv> {
    const app = new Hono<AuthEnv>();
    app.use('*', async (c, next) => {
      c.set('user', { sub: 'u1', role: 'admin', iat: 0, exp: 0 } as JwtPayload);
      await next();
    });
    app.route(
      '/',
      libraryRoutes('/nonexistent-music-dir', { coverCacheDir: join(dataDir, 'cover-cache') }),
    );
    app.route('/api', streamingRoutes('/nonexistent-music-dir', testDb, dataDir));
    return app;
  }

  beforeEach(() => {
    testDb = new Database(':memory:');
    applySchema(testDb);
    dataDir = mkdtempSync(join(tmpdir(), 'nd-cover-cache-'));
    clearCoverNegativeCache(); // isolate from other suites' module-level negative cache
    globalThis.fetch = (async (_input: RequestInfo | URL) =>
      new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch;
  });
  afterEach(() => {
    testDb.close();
    rmSync(dataDir, { recursive: true, force: true });
    globalThis.fetch = realFetch;
  });

  it('serves the new cover right after applying it, even though the album was 404-cached first', async () => {
    seedAlbum(testDb);
    const app = makeCombinedApp();

    // The album's file doesn't actually exist under the (fake) music dir, so the
    // first request 404s and memoizes 'album-1' in the negative-art cache —
    // mirroring an album that had no artwork before the user fixed it.
    const before = await app.request('/api/cover/album-1');
    expect(before.status).toBe(404);

    const apply = await app.request('/albums/album-1/cover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ coverUrl: 'https://img/new.jpg' }),
    });
    expect(apply.status).toBe(200);

    // Simulates the user refreshing the page: must see the new cover now, not
    // the stale cached 404 (which would otherwise persist for up to 10 minutes).
    const after = await app.request('/api/cover/album-1');
    expect(after.status).toBe(200);
    expect(after.headers.get('content-type')).toBe('image/png');
  });
});
