/**
 * Route tests for the multi-source metadata-candidates gatherer (issue #411):
 * no more 503 when Lidarr is unconfigured — the route always 200s with a
 * `sources[]` status report, and admin gating / 404 behavior are preserved.
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

const lidarr = {
  album: {
    lookup: async () => [
      {
        foreignAlbumId: 'rg1',
        title: 'Drukqs',
        releaseDate: '2001-10-22',
        albumType: 'Album',
        artist: { artistName: 'Aphex Twin' },
        images: [],
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

describe('GET /albums/:id/metadata-candidates', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    applySchema(testDb);
  });
  afterEach(() => testDb.close());

  it('returns candidates with source:lidarr and a sources[] status report', async () => {
    seedAlbum(testDb);
    const res = await makeApp().request('/albums/album-1/metadata-candidates');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      album: { id: string; name: string; artist: string };
      candidates: { source?: string }[];
      sources: { id: string; ok: boolean }[];
      identifyAvailable: boolean;
    };
    expect(body.album).toEqual({ id: 'album-1', name: 'Drukqs', artist: 'Aphex Twin' });
    expect(body.candidates[0]?.source).toBe('lidarr');
    // musicDir is configured ('/music') so the tags source also runs, but the
    // song file doesn't actually exist on disk → it degrades to an empty,
    // still-`ok` result rather than contributing a candidate or failing.
    expect(body.sources).toEqual(
      expect.arrayContaining([
        { id: 'lidarr', ok: true },
        { id: 'tags', ok: true },
      ]),
    );
    expect(body.identifyAvailable).toBe(false);
  });

  it('200s (no longer 503s) when Lidarr is unconfigured, omitting it from sources', async () => {
    seedAlbum(testDb);
    const res = await makeApp('admin', false).request('/albums/album-1/metadata-candidates');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sources: { id: string }[]; candidates: unknown[] };
    expect(body.sources.some((s) => s.id === 'lidarr')).toBe(false);
    expect(body.candidates).toEqual([]);
  });

  it('404s for an unknown album', async () => {
    const res = await makeApp().request('/albums/nope/metadata-candidates');
    expect(res.status).toBe(404);
  });

  it('rejects a non-admin', async () => {
    seedAlbum(testDb);
    const res = await makeApp('user').request('/albums/album-1/metadata-candidates');
    expect(res.status).toBe(403);
  });
});
