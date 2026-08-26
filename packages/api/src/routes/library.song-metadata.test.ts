/**
 * Route tests for the song-scoped metadata surface (issue #722): the
 * candidates lookup that backs "find this track's real album", and the
 * curator PATCH that retags the file in place (never a move) + rescans.
 */
import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { JwtPayload } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import type { AudioTags } from '../services/audio-tags.js';
import { applySchema } from '../db.js';
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

const relPath = 'Wisin & Yandel/Singles/Pegao (Official Video).opus';

function seedPollutedSong(musicDir: string): void {
  mkdirSync(dirname(join(musicDir, relPath)), { recursive: true });
  writeFileSync(join(musicDir, relPath), 'x');
  testDb.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, cover_art, song_count, duration, year, synced_at)
     VALUES ('album-yt', 'Pegao (Official Video)', 'Wisin & Yandel', 'artist-wy', 'album-yt', 1, 228, NULL, 0)`,
  );
  testDb.run(
    `INSERT INTO library_songs
       (id, album_id, title, artist, artist_id, duration, path, size, created, synced_at)
     VALUES ('song-yt', 'album-yt', 'Pegao (Official Video)', 'Wisin & Yandel', 'artist-wy', 228, ?, 1, '2026-08-01', 1)`,
    [relPath],
  );
}

function makeApp(
  role: 'refiner' | 'user',
  musicDir: string | undefined,
  opts: LibraryRoutesOptions = {},
): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { sub: 'u1', username: 'curator', role, iat: 0, exp: 0 } as JwtPayload);
    await next();
  });
  app.route('/', libraryRoutes(musicDir, opts));
  return app;
}

beforeEach(() => {
  testDb = new Database(':memory:');
  applySchema(testDb);
});
afterEach(() => testDb.close());

describe('GET /songs/:id/metadata-candidates', () => {
  it('403s a non-curator', async () => {
    const app = makeApp('user', '/music');
    const res = await app.request('/songs/song-yt/metadata-candidates');
    expect(res.status).toBe(403);
  });

  it('404s an unknown song', async () => {
    const app = makeApp('refiner', '/music');
    const res = await app.request('/songs/nope/metadata-candidates');
    expect(res.status).toBe(404);
  });

  it('returns the gather result with the cleaner suggestion', async () => {
    const musicDir = mkdtempSync(join(tmpdir(), 'nicotind-smc-'));
    seedPollutedSong(musicDir);
    const app = makeApp('refiner', musicDir);
    const res = await app.request('/songs/song-yt/metadata-candidates');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      song: { id: string };
      suggested: { title: string; album: string | null } | null;
      sources: unknown[];
    };
    expect(body.song.id).toBe('song-yt');
    expect(body.suggested).toMatchObject({ title: 'Pegao', album: 'Pegao' });
  });
});

describe('PATCH /songs/:id/metadata', () => {
  it('403s a non-curator', async () => {
    const app = makeApp('user', '/music');
    const res = await app.request('/songs/song-yt/metadata', {
      method: 'PATCH',
      body: JSON.stringify({ title: 'Pegao' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(403);
  });

  it('400s a body with no applicable fields', async () => {
    const musicDir = mkdtempSync(join(tmpdir(), 'nicotind-smc-'));
    seedPollutedSong(musicDir);
    const app = makeApp('refiner', musicDir);
    const res = await app.request('/songs/song-yt/metadata', {
      method: 'PATCH',
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });

  it('404s an unknown song', async () => {
    const musicDir = mkdtempSync(join(tmpdir(), 'nicotind-smc-'));
    const app = makeApp('refiner', musicDir);
    const res = await app.request('/songs/nope/metadata', {
      method: 'PATCH',
      body: JSON.stringify({ title: 'X' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(404);
  });

  it('writes tags, rescans, audits, and reports the applied fields', async () => {
    const musicDir = mkdtempSync(join(tmpdir(), 'nicotind-smc-'));
    seedPollutedSong(musicDir);
    const written: AudioTags[] = [];
    const rescanned: string[][] = [];
    const app = makeApp('refiner', musicDir, {
      writeTags: async (_abs, tags) => {
        written.push(tags);
        return true;
      },
      scanIncremental: async (paths) => {
        rescanned.push(paths);
      },
    });
    const res = await app.request('/songs/song-yt/metadata', {
      method: 'PATCH',
      body: JSON.stringify({ title: 'Pegao', album: 'Los Extraterrestres' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      rescanned: true,
      applied: { title: 'Pegao', album: 'Los Extraterrestres' },
    });
    expect(written[0]).toEqual({ title: 'Pegao', album: 'Los Extraterrestres' });
    expect(rescanned[0]).toEqual([relPath]);
    const audit = testDb
      .query<{ action: string; target_id: string; detail: string | null }, []>(
        `SELECT action, target_id, detail FROM audit_log`,
      )
      .all();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'song.metadata', target_id: 'song-yt' });
    expect(audit[0]?.detail).toContain('Pegao (Official Video)');
    expect(audit[0]?.detail).toContain('Los Extraterrestres');
  });
});
