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
import type { JwtPayload } from '@nicotind/core';
import type { Lidarr } from '@nicotind/lidarr-client';
import type { AuthEnv } from '../middleware/auth.js';
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
