/**
 * Route tests for GET /health — the library health report (issue #734), the
 * on-demand entry point of a curation pass. Curator-gated: health of library
 * content is curation information, not server administration.
 */
import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { JwtPayload } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { applySchema } from '../db.js';
import { artistIdFor } from '../services/library-scanner.js';
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

function makeApp(role: 'admin' | 'refiner' | 'user'): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { sub: 'u1', username: 'curator', role, iat: 0, exp: 0 } as JwtPayload);
    await next();
  });
  app.route('/', libraryRoutes(undefined));
  return app;
}

beforeEach(() => {
  testDb = new Database(':memory:');
  applySchema(testDb);
});
afterEach(() => testDb.close());

function seedCoverlessAlbums(n: number): void {
  testDb.run(
    `INSERT INTO library_artists (id, name, album_count, synced_at) VALUES ('ar1', 'A', ?, 1)`,
    [n],
  );
  for (let i = 0; i < n; i++) {
    testDb.run(
      `INSERT INTO library_albums
        (id, name, artist, artist_id, song_count, classification, hidden, year, cover_art, synced_at)
       VALUES (?, ?, 'A', 'ar1', 1, 'album', 0, 2000, ?, 1)`,
      [`al${i}`, `N${i}`, `al${i}`],
    );
  }
}

describe('GET /health', () => {
  it('403s a non-curator', async () => {
    const res = await makeApp('user').request('/health');
    expect(res.status).toBe(403);
  });

  it('returns the full report for a curator', async () => {
    seedCoverlessAlbums(3);
    const res = await makeApp('refiner').request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totals: { albums: number };
      dimensions: { albumCovers: { metric: { missing: number } } };
    };
    expect(body.totals.albums).toBe(3);
    expect(body.dimensions.albumCovers.metric.missing).toBe(3);
  });

  it('honors ?sample= for worklist bounds', async () => {
    seedCoverlessAlbums(5);
    const res = await makeApp('refiner').request('/health?sample=2');
    const body = (await res.json()) as {
      dimensions: { albumCovers: { worklist: unknown[] } };
    };
    expect(body.dimensions.albumCovers.worklist).toHaveLength(2);
  });
});

// #1444: the Admin Incomplete Albums panel — admin-only, like the panel it feeds.
describe('GET /incomplete-albums', () => {
  it('403s a curator who is not an admin', async () => {
    const res = await makeApp('refiner').request('/incomplete-albums');
    expect(res.status).toBe(403);
  });

  it('lists an album a hunt would complete', async () => {
    testDb.run(
      `INSERT INTO library_artists (id, name, album_count, synced_at) VALUES (?, 'A', 1, 1)`,
      [artistIdFor('A')],
    );
    testDb.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, classification, hidden, synced_at)
       VALUES ('al1', 'Jazz', 'A', ?, 1, 'album', 0, 1)`,
      [artistIdFor('A')],
    );
    testDb.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, path, suffix, synced_at)
       VALUES ('s1', 'al1', 'Mustapha', 'A', ?, '/m/s1.opus', 'opus', 1)`,
      [artistIdFor('A')],
    );
    testDb.run(
      `INSERT INTO acquisition_jobs
         (id, kind, method, state, stage, artist_name, album_title, lidarr_album_id,
          canonical_tracks_json, created_at, updated_at)
       VALUES ('j1', 'album-hunt', 'slskd', 'done', 'done', 'A', 'Jazz', 7, ?, 1, 1)`,
      [JSON.stringify(['Mustapha', 'Jealousy'])],
    );

    const res = await makeApp('admin').request('/incomplete-albums');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toEqual([
      expect.objectContaining({
        album: 'Jazz',
        expected: 2,
        owned: 1,
        missing: 1,
        lidarrAlbumId: 7,
      }),
    ]);
  });
});
