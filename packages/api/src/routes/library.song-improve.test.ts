/**
 * #2032: `POST /songs/:id/improve` — "get a better copy" of one song, the web
 * twin of MCP `improve_song`, through the same `requestBetterCopy`.
 */
import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { JwtPayload } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { applySchema } from '../db.js';
import type { TrackGetRequest } from '../services/track-get.service.js';
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

const requests: TrackGetRequest[] = [];

function makeApp(
  role: 'refiner' | 'user',
  options: LibraryRoutesOptions = {
    acquisition: { getAddon: () => null, isAcquisitionEnabled: () => true, minMatchPct: 80 },
    requestTrackGet: (req) => {
      requests.push(req);
      return { status: 'accepted', jobId: 'job-9' };
    },
  },
): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { sub: 'u1', username: 'kev', role, iat: 0, exp: 0 } as JwtPayload);
    await next();
  });
  app.route('/', libraryRoutes(undefined, options));
  return app;
}

const improve = (app: Hono<AuthEnv>, id = 's1') =>
  app.request(`/songs/${id}/improve`, { method: 'POST' });

beforeEach(() => {
  testDb = new Database(':memory:');
  applySchema(testDb);
  requests.length = 0;
  // The album row was renamed by a curator; the file still sits in its folder.
  testDb.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
     VALUES ('al', 'Geogaddi (Curated)', 'Boards of Canada', 'boc', 1, 60, 1)`,
  );
  testDb.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, synced_at)
     VALUES ('s1', 'al', 'Music Is Math', 'Boards of Canada', 'boc', 60, 'Boards of Canada/Geogaddi/01 - Music Is Math.mp3', 1),
            ('s2', 'al', 'Dawn Chorus', 'Boards of Canada', 'boc', 60, 'Boards of Canada/Singles/Dawn Chorus.mp3', 1)`,
  );
});

describe('POST /songs/:id/improve', () => {
  it("starts a track Get named after the song's own folder, not the renamed album row", async () => {
    const res = await improve(makeApp('refiner'));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, outcome: 'started', jobId: 'job-9' });
    expect(requests).toEqual([
      { artist: 'Boards of Canada', title: 'Music Is Math', album: 'Geogaddi', userId: 'u1' },
    ]);
  });

  it('refuses a loose single, which no reconcile would replace in place', async () => {
    const res = await improve(makeApp('refiner'), 's2');
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ reason: 'not-in-album-folder' });
    expect(requests).toHaveLength(0);
  });

  it('is a curator action', async () => {
    expect((await improve(makeApp('user'))).status).toBe(403);
    expect(requests).toHaveLength(0);
  });

  it('404s an unknown song and 403s with the kill-switch off', async () => {
    expect((await improve(makeApp('refiner'), 'nope')).status).toBe(404);
    const off = makeApp('refiner', {
      acquisition: { getAddon: () => null, isAcquisitionEnabled: () => false, minMatchPct: 80 },
      requestTrackGet: () => ({ status: 'accepted', jobId: 'x' }),
    });
    const res = await improve(off);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: 'acquisition-disabled' });
  });

  it('503s when no source is registered or acquisition is not wired', async () => {
    const none = makeApp('refiner', {
      acquisition: { getAddon: () => null, isAcquisitionEnabled: () => true, minMatchPct: 80 },
      requestTrackGet: () => ({ status: 'no-addon' }),
    });
    expect((await improve(none)).status).toBe(503);
    expect((await improve(makeApp('refiner', {}))).status).toBe(503);
  });
});
