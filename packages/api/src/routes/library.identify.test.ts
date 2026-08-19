/**
 * Route tests for the track-info AcoustID identify surface: availability
 * signal, per-song fingerprint identify, and the curator apply that writes
 * the approved tags back to the file + rescans.
 */
import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { JwtPayload, IdentifyOutcome, IdentifyResult } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import type { PluginRegistry } from '../services/plugins/registry.js';
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

/** A registry stub exposing only the `identify` capability. */
function makeIdentifyRegistry(
  fn: (abs: string) => Promise<IdentifyResult | null>,
  detailed?: (abs: string) => Promise<IdentifyOutcome>,
): PluginRegistry {
  const plugin = {
    manifest: { id: 'acoustid' },
    identify: detailed
      ? { identifyTrack: fn, identifyTrackDetailed: detailed }
      : { identifyTrack: fn },
  };
  return {
    getEnabledWithCapability: (cap: string) => (cap === 'identify' ? [plugin] : []),
    getConfig: () => ({ apiKey: 'k' }),
  } as unknown as PluginRegistry;
}

function noIdentifyRegistry(): PluginRegistry {
  return {
    getEnabledWithCapability: () => [],
    getConfig: () => ({}),
  } as unknown as PluginRegistry;
}

function seedSongWithFile(musicDir: string, songId: string, relPath: string): void {
  writeFileSync(join(musicDir, relPath), 'x');
  testDb.run(
    `INSERT INTO library_songs
       (id, album_id, title, artist, artist_id, duration, path, size, created, synced_at)
     VALUES (?, 'al1', 'T', 'Artist', 'art', 0, ?, 1, '2024-01-01', 1)`,
    [songId, relPath],
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

describe('GET /identify/available', () => {
  it('reports true when an identify plugin is enabled with an api key', async () => {
    const app = makeApp('refiner', '/music', {
      pluginRegistry: makeIdentifyRegistry(async () => null),
    });
    const res = await app.request('/identify/available');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: true });
  });

  it('reports false when no identify plugin is enabled', async () => {
    const app = makeApp('refiner', '/music', { pluginRegistry: noIdentifyRegistry() });
    const res = await app.request('/identify/available');
    expect(await res.json()).toEqual({ available: false });
  });
});

describe('POST /songs/:id/identify', () => {
  it('403s a non-curator', async () => {
    const app = makeApp('user', '/music', {
      pluginRegistry: makeIdentifyRegistry(async () => null),
    });
    const res = await app.request('/songs/s1/identify', { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('200 with the mapped result from the enabled plugin', async () => {
    const musicDir = mkdtempSync(join(tmpdir(), 'nicotind-identify-'));
    seedSongWithFile(musicDir, 's1', 's1.mp3');
    const result: IdentifyResult = { acoustId: 'abc', score: 0.95, artist: 'X', album: 'Y' };
    const app = makeApp('refiner', musicDir, {
      pluginRegistry: makeIdentifyRegistry(async () => result),
    });
    const res = await app.request('/songs/s1/identify', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result, outcome: { kind: 'match', result } });
  });

  it('passes a typed failure outcome through to the client', async () => {
    const musicDir = mkdtempSync(join(tmpdir(), 'nicotind-identify-'));
    seedSongWithFile(musicDir, 's1', 's1.mp3');
    const app = makeApp('refiner', musicDir, {
      pluginRegistry: makeIdentifyRegistry(
        async () => null,
        async () => ({ kind: 'undecodable', detail: 'ERROR: invalid data found' }),
      ),
    });
    const res = await app.request('/songs/s1/identify', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      result: null,
      outcome: { kind: 'undecodable', detail: 'ERROR: invalid data found' },
    });
  });

  it('503s when no identify plugin is enabled', async () => {
    const musicDir = mkdtempSync(join(tmpdir(), 'nicotind-identify-'));
    seedSongWithFile(musicDir, 's1', 's1.mp3');
    const app = makeApp('refiner', musicDir, { pluginRegistry: noIdentifyRegistry() });
    const res = await app.request('/songs/s1/identify', { method: 'POST' });
    expect(res.status).toBe(503);
  });

  it('404s for an unknown song and for a missing file', async () => {
    const musicDir = mkdtempSync(join(tmpdir(), 'nicotind-identify-'));
    const app = makeApp('refiner', musicDir, {
      pluginRegistry: makeIdentifyRegistry(async () => null),
    });
    expect((await app.request('/songs/nope/identify', { method: 'POST' })).status).toBe(404);

    testDb.run(
      `INSERT INTO library_songs
         (id, album_id, title, artist, artist_id, duration, path, size, created, synced_at)
       VALUES ('gone', 'al1', 'T', 'Artist', 'art', 0, 'gone.mp3', 1, '2024-01-01', 1)`,
    );
    expect((await app.request('/songs/gone/identify', { method: 'POST' })).status).toBe(404);
  });
});

describe('POST /songs/:id/identify/apply', () => {
  async function postApply(app: Hono<AuthEnv>, id: string, body: unknown): Promise<Response> {
    return await app.request(`/songs/${id}/identify/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('403s a non-curator', async () => {
    const app = makeApp('user', '/music');
    const res = await postApply(app, 's1', { title: 'T' });
    expect(res.status).toBe(403);
  });

  it('404s for an unknown song', async () => {
    const app = makeApp('refiner', '/music');
    const res = await postApply(app, 'nope', { title: 'T' });
    expect(res.status).toBe(404);
  });

  it('writes the approved tags (MBIDs mapped), rescans, and audits', async () => {
    const musicDir = mkdtempSync(join(tmpdir(), 'nicotind-identify-'));
    seedSongWithFile(musicDir, 's1', 's1.mp3');
    const written: Array<{ abs: string; tags: AudioTags }> = [];
    const scanned: string[][] = [];
    const app = makeApp('refiner', musicDir, {
      writeTags: async (abs, tags) => {
        written.push({ abs, tags });
        return true;
      },
      scanIncremental: async (relPaths) => {
        scanned.push(relPaths);
      },
    });

    const res = await postApply(app, 's1', {
      title: 'Real Title',
      artist: 'Real Artist',
      album: 'Real Album',
      albumArtist: 'Real Artist',
      year: 2001,
      trackNumber: 3,
      acoustId: 'ac-1',
      recordingId: 'rec-1',
      releaseId: 'rel-1',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, rescanned: true });

    expect(written).toHaveLength(1);
    expect(written[0]!.abs).toBe(join(musicDir, 's1.mp3'));
    expect(written[0]!.tags).toEqual({
      title: 'Real Title',
      artist: 'Real Artist',
      album: 'Real Album',
      albumArtist: 'Real Artist',
      year: 2001,
      trackNumber: 3,
      acoustIdId: 'ac-1',
      mbRecordingId: 'rec-1',
      mbReleaseId: 'rel-1',
    });
    expect(scanned).toEqual([['s1.mp3']]);

    const audit = testDb
      .query("SELECT action, target_id FROM audit_log WHERE action = 'song.identify_apply'")
      .get() as { action: string; target_id: string } | null;
    expect(audit?.target_id).toBe('s1');
  });

  it('400s a body with no applicable fields', async () => {
    const musicDir = mkdtempSync(join(tmpdir(), 'nicotind-identify-'));
    seedSongWithFile(musicDir, 's1', 's1.mp3');
    const app = makeApp('refiner', musicDir, { writeTags: async () => true });
    const res = await postApply(app, 's1', {});
    expect(res.status).toBe(400);
  });

  it('500s when the tag write fails', async () => {
    const musicDir = mkdtempSync(join(tmpdir(), 'nicotind-identify-'));
    seedSongWithFile(musicDir, 's1', 's1.mp3');
    const app = makeApp('refiner', musicDir, { writeTags: async () => false });
    const res = await postApply(app, 's1', { title: 'T' });
    expect(res.status).toBe(500);
  });
});
