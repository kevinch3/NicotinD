/**
 * Issue #737: the album page's completeness read (any signed-in user) and its
 * curator-only "Complete this album" action — the web twin of MCP
 * `complete_album`, through the same `completeAlbum`.
 */
import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { JwtPayload } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import type { Lidarr } from '../lidarr/index.js';
import { applySchema } from '../db.js';
import { artistIdFor } from '../services/library-scanner.js';
import { libraryRoutes, type LibraryRoutesOptions } from './library.js';

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

const artist = 'Boards of Canada';
const arId = artistIdFor(artist);

function makeApp(role: 'refiner' | 'user', options: LibraryRoutesOptions = {}): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { sub: 'u1', username: 'kev', role, iat: 0, exp: 0 } as JwtPayload);
    await next();
  });
  app.route('/', libraryRoutes(undefined, options));
  return app;
}

function makeLidarr(tracks: string[], listCalls: number[] = []): Lidarr {
  return {
    track: {
      listByAlbum: async (id: number) => {
        listCalls.push(id);
        return tracks.map((title) => ({ title }));
      },
    },
    album: { lookup: async () => [] },
  } as unknown as Lidarr;
}

const acquisition = (enabled = true): NonNullable<LibraryRoutesOptions['acquisition']> => ({
  getAddon: () => null,
  isAcquisitionEnabled: () => enabled,
  minMatchPct: 80,
});

function seed(owned: string[], canonical: string[]): void {
  testDb.run(
    `INSERT INTO library_albums
      (id, name, artist, artist_id, song_count, classification, hidden, cover_art, synced_at)
     VALUES ('al-geo', 'Geogaddi', ?, ?, ?, 'album', 0, 'al-geo', 1)`,
    [artist, arId, owned.length],
  );
  owned.forEach((t, i) =>
    testDb.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, synced_at)
       VALUES (?, 'al-geo', ?, ?, ?, 60, ?, 1)`,
      [`s${i}`, t, artist, arId, `boc/${i}.opus`],
    ),
  );
  testDb.run(
    `INSERT INTO acquisition_jobs
      (id, kind, method, state, stage, artist_name, album_title, lidarr_album_id,
       canonical_tracks_json, created_at, updated_at)
     VALUES ('job-1', 'album-hunt', 'slskd', 'done', 'done', ?, 'Geogaddi', 55, ?, 1, 1)`,
    [artist, JSON.stringify(canonical)],
  );
}

beforeEach(() => {
  testDb = new Database(':memory:');
  applySchema(testDb);
});
afterEach(() => testDb.close());

describe('GET /albums/:id/completeness', () => {
  it('reports a confirmed-incomplete album to any signed-in user', async () => {
    seed(['Ready Lets Go'], ['Ready Lets Go', 'Music Is Math', 'Sunshine Recorder']);
    const res = await makeApp('user').request('/albums/al-geo/completeness');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      albumId: 'al-geo',
      confirmed: { expected: 3, owned: 1, missing: 2 },
    });
  });

  it('reads null for a complete album', async () => {
    seed(['Ready Lets Go', 'Music Is Math'], ['Ready Lets Go', 'Music Is Math']);
    const res = await makeApp('user').request('/albums/al-geo/completeness');
    expect(await res.json()).toEqual({ albumId: 'al-geo', confirmed: null });
  });

  it('404s an unknown album', async () => {
    expect((await makeApp('user').request('/albums/nope/completeness')).status).toBe(404);
  });
});

describe('POST /albums/:id/complete', () => {
  const post = (app: Hono<AuthEnv>) => app.request('/albums/al-geo/complete', { method: 'POST' });

  it('403s a non-curator', async () => {
    seed(['Ready Lets Go'], ['Ready Lets Go', 'Music Is Math']);
    const res = await post(makeApp('user', { lidarr: makeLidarr([]), acquisition: acquisition() }));
    expect(res.status).toBe(403);
  });

  it('503s when acquisition is not wired', async () => {
    seed(['Ready Lets Go'], ['Ready Lets Go', 'Music Is Math']);
    expect((await post(makeApp('refiner', { lidarr: makeLidarr([]) }))).status).toBe(503);
  });

  it('refuses under the kill-switch without touching Lidarr', async () => {
    seed(['Ready Lets Go'], ['Ready Lets Go', 'Music Is Math']);
    const calls: number[] = [];
    const res = await post(
      makeApp('refiner', { lidarr: makeLidarr([], calls), acquisition: acquisition(false) }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'acquisition-disabled' });
    expect(calls).toEqual([]);
  });

  it("hunts the unified job's Lidarr album and surfaces already-complete as an outcome", async () => {
    seed(['Ready Lets Go'], ['Ready Lets Go', 'Music Is Math']);
    const calls: number[] = [];
    const res = await post(
      makeApp('refiner', {
        lidarr: makeLidarr(['Ready Lets Go'], calls),
        acquisition: acquisition(),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, outcome: 'already-complete', lidarrAlbumId: 55 });
    expect(calls).toEqual([55]);
    const audit = testDb
      .query<{ username: string; detail: string }, []>('SELECT username, detail FROM audit_log')
      .all();
    expect(audit).toEqual([
      { username: 'kev', detail: 'outcome=already-complete lidarrAlbumId=55' },
    ]);
  });

  it('reports a missing addon as an outcome, not an error', async () => {
    seed(['Ready Lets Go'], ['Ready Lets Go', 'Music Is Math']);
    const res = await post(
      makeApp('refiner', {
        lidarr: makeLidarr(['Ready Lets Go', 'Music Is Math']),
        acquisition: acquisition(),
      }),
    );
    expect(await res.json()).toMatchObject({ ok: true, outcome: 'slskd-unavailable' });
  });
});
