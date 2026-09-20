/**
 * Route tests for on-demand lyrics: GET stored, POST fetch (with a stubbed
 * lyrics plugin), customized-edit protection, the 503 no-source gate, and the
 * admin-gated edit/reset. No network/ffmpeg — the seeded file isn't on disk, so
 * the tag write-back is skipped while the DB persistence path is exercised.
 */
import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { JwtPayload, LyricsResult } from '@nicotind/core';
import { LYRICS_OFFSET_MAX_MS } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import type { PluginRegistry } from '../services/plugins/registry.js';
import { applySchema } from '../db.js';
import { libraryRoutes } from './library.js';
import { getLyrics } from '../services/lyrics-store.js';
import { writeAudioTags } from '../services/audio-tags.js';

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

function seedSong(db: Database, id: string): void {
  db.run(
    `INSERT INTO library_songs
      (id, album_id, title, artist, artist_id, duration, path,
       size, bit_rate, suffix, content_type, created, synced_at)
     VALUES (?, 'album-1', 'Selva', 'La Portuaria', 'artist-1', 200,
       'La Portuaria/Huija/01 - Selva.flac', 1000, 1000, 'flac', 'audio/flac', '2024-01-01', 0)`,
    [id],
  );
}

/** A registry stub exposing only what the lyrics routes call. */
function makeRegistry(opts: {
  result?: LyricsResult | null;
  enabled?: boolean;
  throws?: boolean;
}): {
  registry: PluginRegistry;
  calls: () => number;
} {
  let calls = 0;
  const enabled = opts.enabled ?? true;
  const plugin = {
    lyrics: {
      fetchLyrics: async () => {
        calls++;
        if (opts.throws) throw new Error('LRCLIB unavailable');
        return opts.result ?? null;
      },
    },
  };
  const registry = {
    hasCapability: () => enabled,
    getEnabledWithCapability: () => (enabled ? [plugin] : []),
  } as unknown as PluginRegistry;
  return { registry, calls: () => calls };
}

function makeApp(role: 'admin' | 'user', registry?: PluginRegistry): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { sub: 'u1', role, iat: 0, exp: 0 } as JwtPayload);
    await next();
  });
  app.route('/', libraryRoutes('/music', { pluginRegistry: registry }));
  return app;
}

const LYRICS: LyricsResult = { plain: 'la selva', synced: '[00:01.00]la selva', source: 'lrclib' };

beforeEach(() => {
  testDb = new Database(':memory:');
  applySchema(testDb);
});
afterEach(() => testDb.close());

describe('GET /songs/:id/lyrics', () => {
  it('returns null when no lyrics are stored', async () => {
    seedSong(testDb, 'song-1');
    const res = await makeApp('user').request('/songs/song-1/lyrics');
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  it('404s for an unknown song', async () => {
    const res = await makeApp('user').request('/songs/nope/lyrics');
    expect(res.status).toBe(404);
  });
});

describe('POST /songs/:id/lyrics/fetch', () => {
  it('fetches, persists, and returns lyrics', async () => {
    seedSong(testDb, 'song-1');
    const { registry } = makeRegistry({ result: LYRICS });
    const res = await makeApp('user', registry).request('/songs/song-1/lyrics/fetch', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plain: string; synced: string; source: string };
    expect(body.plain).toBe('la selva');
    expect(body.source).toBe('lrclib');
    expect(getLyrics(testDb, 'song-1')?.plain).toBe('la selva');
  });

  it('serves a cached row without re-querying the source', async () => {
    seedSong(testDb, 'song-1');
    const { registry, calls } = makeRegistry({ result: LYRICS });
    const app = makeApp('user', registry);
    await app.request('/songs/song-1/lyrics/fetch', { method: 'POST' });
    await app.request('/songs/song-1/lyrics/fetch', { method: 'POST' });
    expect(calls()).toBe(1);
  });

  it('re-queries when force is set', async () => {
    seedSong(testDb, 'song-1');
    const { registry, calls } = makeRegistry({ result: LYRICS });
    const app = makeApp('user', registry);
    await app.request('/songs/song-1/lyrics/fetch', { method: 'POST' });
    await app.request('/songs/song-1/lyrics/fetch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });
    expect(calls()).toBe(2);
  });

  it('503s when no lyrics source is enabled', async () => {
    seedSong(testDb, 'song-1');
    const { registry } = makeRegistry({ enabled: false });
    const res = await makeApp('user', registry).request('/songs/song-1/lyrics/fetch', {
      method: 'POST',
    });
    expect(res.status).toBe(503);
  });

  it('returns null when the source has no lyrics', async () => {
    seedSong(testDb, 'song-1');
    const { registry } = makeRegistry({ result: null });
    const res = await makeApp('user', registry).request('/songs/song-1/lyrics/fetch', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  it('returns 502 (not a false null) when the source errors', async () => {
    // A transient LRCLIB failure must surface as an error the client can retry,
    // not masquerade as a confident "no lyrics found".
    seedSong(testDb, 'song-1');
    const { registry } = makeRegistry({ throws: true });
    const res = await makeApp('user', registry).request('/songs/song-1/lyrics/fetch', {
      method: 'POST',
    });
    expect(res.status).toBe(502);
    // Nothing persisted — a later fetch can still succeed.
    expect(getLyrics(testDb, 'song-1')).toBeNull();
  });

  it('recovers lyrics from the file tag before reaching a source', async () => {
    // A real on-disk file whose tag holds lyrics (the post-transcode recovery
    // path): the orphaned DB row is reseeded from the tag, no source needed.
    const dir = mkdtempSync(join(tmpdir(), 'nicotind-lyrics-'));
    try {
      const rel = 'La Portuaria/Huija/01 - Selva.mp3';
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      copyFileSync(join(import.meta.dir, '../../test-fixtures/silence.mp3'), abs);
      await writeAudioTags(abs, { lyrics: 'embedded words' });

      testDb.run(
        `INSERT INTO library_songs
          (id, album_id, title, artist, artist_id, duration, path,
           size, bit_rate, suffix, content_type, created, synced_at)
         VALUES ('song-9', 'album-1', 'Selva', 'La Portuaria', 'artist-1', 200, ?,
           1000, 1000, 'mp3', 'audio/mpeg', '2024-01-01', 0)`,
        [rel],
      );

      // No lyrics source enabled — recovery must still succeed from the tag.
      const { registry } = makeRegistry({ enabled: false });
      const app = new Hono<AuthEnv>();
      app.use('*', async (c, next) => {
        c.set('user', { sub: 'u1', role: 'user', iat: 0, exp: 0 } as JwtPayload);
        await next();
      });
      app.route('/', libraryRoutes(dir, { pluginRegistry: registry }));

      const res = await app.request('/songs/song-9/lyrics/fetch', { method: 'POST' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { plain: string; source: string };
      expect(body.plain).toBe('embedded words');
      expect(body.source).toBe('file-tag');
      expect(getLyrics(testDb, 'song-9')?.plain).toBe('embedded words');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PUT /songs/:id/lyrics', () => {
  it('saves a user edit as customized (admin)', async () => {
    seedSong(testDb, 'song-1');
    const res = await makeApp('admin').request('/songs/song-1/lyrics', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plain: 'my words' }),
    });
    expect(res.status).toBe(200);
    const row = getLyrics(testDb, 'song-1');
    expect(row?.plain).toBe('my words');
    expect(row?.customized).toBe(true);
    expect(row?.source).toBe('user');
  });

  it('protects a customized row from a non-forced re-fetch', async () => {
    seedSong(testDb, 'song-1');
    const { registry, calls } = makeRegistry({ result: LYRICS });
    await makeApp('admin').request('/songs/song-1/lyrics', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plain: 'my words' }),
    });
    const res = await makeApp('user', registry).request('/songs/song-1/lyrics/fetch', {
      method: 'POST',
    });
    expect((await res.json()).plain).toBe('my words');
    expect(calls()).toBe(0);
  });

  it('rejects a non-admin edit', async () => {
    seedSong(testDb, 'song-1');
    const res = await makeApp('user').request('/songs/song-1/lyrics', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plain: 'x' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /songs/:id/lyrics', () => {
  it('resets lyrics (admin)', async () => {
    seedSong(testDb, 'song-1');
    await makeApp('admin').request('/songs/song-1/lyrics', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plain: 'x' }),
    });
    const res = await makeApp('admin').request('/songs/song-1/lyrics', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(getLyrics(testDb, 'song-1')).toBeNull();
  });

  it('rejects a non-admin reset', async () => {
    seedSong(testDb, 'song-1');
    const res = await makeApp('user').request('/songs/song-1/lyrics', { method: 'DELETE' });
    expect(res.status).toBe(403);
  });
});

/**
 * PUT used to hard-code `synced: null`, so the only way a curator could act on
 * bad timing was to erase every timestamp. Keeping an explicitly-sent LRC is
 * what makes a timing fix possible at all — and what lets e2e seed synced
 * lyrics, which had no route to do before.
 */
describe('PUT /songs/:id/lyrics keeps synced text when it is sent', () => {
  it('clears the stored LRC when only plain text is sent', async () => {
    seedSong(testDb, 'song-1');
    const { registry } = makeRegistry({ result: LYRICS });
    await makeApp('user', registry).request('/songs/song-1/lyrics/fetch', { method: 'POST' });
    expect(getLyrics(testDb, 'song-1')?.synced).toBe('[00:01.00]la selva');

    await makeApp('admin').request('/songs/song-1/lyrics', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plain: 'rewritten' }),
    });
    // The edited body no longer lines up with timings written for the old text.
    expect(getLyrics(testDb, 'song-1')?.synced).toBeNull();
  });

  it('keeps the LRC verbatim when synced is sent alongside plain', async () => {
    seedSong(testDb, 'song-1');
    const res = await makeApp('admin').request('/songs/song-1/lyrics', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plain: 'la selva', synced: '[00:02.50]la selva' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).synced).toBe('[00:02.50]la selva');
    expect(getLyrics(testDb, 'song-1')?.synced).toBe('[00:02.50]la selva');
  });

  it('treats a blank synced string as none, not as empty timings', async () => {
    seedSong(testDb, 'song-1');
    await makeApp('admin').request('/songs/song-1/lyrics', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plain: 'words', synced: '   ' }),
    });
    expect(getLyrics(testDb, 'song-1')?.synced).toBeNull();
  });
});

/**
 * The sync correction. It must never touch the words — that is the whole reason
 * it is a separate route from PUT.
 */
describe('PATCH /songs/:id/lyrics/offset', () => {
  async function seedFetched(): Promise<void> {
    seedSong(testDb, 'song-1');
    const { registry } = makeRegistry({ result: LYRICS });
    await makeApp('user', registry).request('/songs/song-1/lyrics/fetch', { method: 'POST' });
  }

  const patch = async (role: 'admin' | 'user', body: unknown): Promise<Response> =>
    makeApp(role).request('/songs/song-1/lyrics/offset', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('stores the offset and leaves the fetched text untouched', async () => {
    await seedFetched();
    const res = await patch('admin', { offsetMs: 1_500 });
    expect(res.status).toBe(200);
    expect((await res.json()).offsetMs).toBe(1_500);

    const stored = getLyrics(testDb, 'song-1');
    expect(stored?.offsetMs).toBe(1_500);
    expect(stored?.synced).toBe('[00:01.00]la selva');
    expect(stored?.plain).toBe('la selva');
    // Not a user edit — the words are still the source's, so a re-fetch may
    // still replace them.
    expect(stored?.customized).toBe(false);
  });

  it('is reversible — zero restores the original timing', async () => {
    await seedFetched();
    await patch('admin', { offsetMs: 2_000 });
    expect((await (await patch('admin', { offsetMs: 0 })).json()).offsetMs).toBe(0);
  });

  it('clamps rather than refusing an out-of-range nudge', async () => {
    await seedFetched();
    const res = await patch('admin', { offsetMs: 10_000_000 });
    expect(res.status).toBe(200);
    expect((await res.json()).offsetMs).toBe(LYRICS_OFFSET_MAX_MS);
  });

  it('rejects a non-numeric offset', async () => {
    await seedFetched();
    expect((await patch('admin', { offsetMs: 'later' })).status).toBe(400);
    expect((await patch('admin', {})).status).toBe(400);
  });

  it('400s when the song has no stored lyrics to correct', async () => {
    seedSong(testDb, 'song-1');
    expect((await patch('admin', { offsetMs: 500 })).status).toBe(400);
  });

  it('404s for an unknown song', async () => {
    const res = await makeApp('admin').request('/songs/nope/lyrics/offset', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ offsetMs: 500 }),
    });
    expect(res.status).toBe(404);
  });

  it('rejects a non-admin sync', async () => {
    await seedFetched();
    expect((await patch('user', { offsetMs: 500 })).status).toBe(403);
  });
});
