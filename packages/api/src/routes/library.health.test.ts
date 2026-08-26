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

function makeApp(role: 'refiner' | 'user'): Hono<AuthEnv> {
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
