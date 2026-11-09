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
import { getLyrics, getLyricsProvenance } from '../services/lyrics-store.js';
import { libraryEvents, type StampedEvent } from '../services/library-events.js';
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

  it('a forced fetch answering untimed returns the stored timed lyrics unchanged (#1672)', async () => {
    seedSong(testDb, 'song-1');
    const stored = '[00:01.00]timed';
    testDb.run(
      `INSERT INTO library_lyrics (song_id, plain_text, synced_text, source, customized, updated_at, offset_ms)
       VALUES ('song-1', 'timed', ?, 'lrclib', 0, 1, 400)`,
      [stored],
    );
    const { registry } = makeRegistry({
      result: { plain: 'untimed', synced: null, source: 'lrclib' },
    });
    const res = await makeApp('user', registry).request('/songs/song-1/lyrics/fetch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ synced: stored, offsetMs: 400 });
    expect(getLyrics(testDb, 'song-1')).toMatchObject({ synced: stored, offsetMs: 400 });
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
      expect(getLyricsProvenance(testDb, 'song-9')?.choice).toMatchObject({
        source: 'file-tag',
        timed: false,
        localDurationSec: 200,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a forced fetch skips the file-tag recovery (#1205)', () => {
  it('asks the source even when the tag holds the words an earlier fetch wrote', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nicotind-lyrics-'));
    try {
      const rel = 'La Portuaria/Huija/01 - Selva.mp3';
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      copyFileSync(join(import.meta.dir, '../../test-fixtures/silence.mp3'), abs);
      // What a bad match leaves behind once its row is reset: the tag.
      await writeAudioTags(abs, { lyrics: 'wrong take words' });
      testDb.run(
        `INSERT INTO library_songs
          (id, album_id, title, artist, artist_id, duration, path,
           size, bit_rate, suffix, content_type, created, synced_at)
         VALUES ('song-9', 'album-1', 'Selva', 'La Portuaria', 'artist-1', 200, ?,
           1000, 1000, 'mp3', 'audio/mpeg', '2024-01-01', 0)`,
        [rel],
      );
      const { registry, calls } = makeRegistry({ result: LYRICS });
      const app = new Hono<AuthEnv>();
      app.use('*', async (c, next) => {
        c.set('user', { sub: 'u1', role: 'user', iat: 0, exp: 0 } as JwtPayload);
        await next();
      });
      app.route('/', libraryRoutes(dir, { pluginRegistry: registry }));

      const res = await app.request('/songs/song-9/lyrics/fetch', {
        method: 'POST',
        body: JSON.stringify({ force: true }),
      });
      expect(calls()).toBe(1);
      expect(((await res.json()) as { source: string }).source).toBe('lrclib');
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

  it('a forced re-fetch answers 409 on a customized row until it is confirmed (#1786)', async () => {
    seedSong(testDb, 'song-1');
    const { registry, calls } = makeRegistry({ result: LYRICS });
    await makeApp('admin').request('/songs/song-1/lyrics', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plain: 'my words' }),
    });
    const fetch = (body: object) =>
      makeApp('user', registry).request('/songs/song-1/lyrics/fetch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    const refused = await fetch({ force: true });
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe('lyrics-customized');
    expect(calls()).toBe(0);
    expect(getLyrics(testDb, 'song-1')?.plain).toBe('my words');

    const confirmed = await fetch({ force: true, confirmReplaceEdit: true });
    expect(confirmed.status).toBe(200);
    expect(calls()).toBe(1);
    expect(getLyrics(testDb, 'song-1')?.customized).toBe(false);
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

  it('is absolute, so a repeated or late write never accumulates (#1656)', async () => {
    await seedFetched();
    await patch('admin', { offsetMs: 750 });
    await patch('admin', { offsetMs: 750 });
    expect(getLyrics(testDb, 'song-1')?.offsetMs).toBe(750);
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

// Another device showing these lyrics (a TV in karaoke while a phone edits them) learns of the
// change only from the event stream, so every write route must emit, and a route that changed
// nothing must not (#1666).
describe('lyrics writes reach open clients as lyrics.changed (#1666)', () => {
  async function changed(fn: () => unknown): Promise<string[]> {
    libraryEvents.flush();
    const seen: StampedEvent[] = [];
    const off = libraryEvents.on((e) => seen.push(e));
    try {
      await fn();
      libraryEvents.flush();
    } finally {
      off();
    }
    return seen.flatMap((e) => (e.event.type === 'lyrics.changed' ? e.event.songIds : []));
  }
  const json = (method: string, body: unknown) => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('a fetch that stores lyrics, an edit, a re-time and a reset each name the song', async () => {
    seedSong(testDb, 'song-1');
    const { registry } = makeRegistry({ result: LYRICS });
    const user = makeApp('user', registry);
    const admin = makeApp('admin');
    expect(
      await changed(() =>
        user.request('/songs/song-1/lyrics/fetch', json('POST', { force: true })),
      ),
    ).toEqual(['song-1']);
    expect(
      await changed(() =>
        admin.request('/songs/song-1/lyrics/offset', json('PATCH', { offsetMs: 500 })),
      ),
    ).toEqual(['song-1']);
    expect(
      await changed(() => admin.request('/songs/song-1/lyrics', json('PUT', { plain: 'mine' }))),
    ).toEqual(['song-1']);
    expect(
      await changed(() => admin.request('/songs/song-1/lyrics', { method: 'DELETE' })),
    ).toEqual(['song-1']);
  });

  it('a fetch that changed nothing stays silent: a cached row, a miss, a kept timed row', async () => {
    seedSong(testDb, 'song-1');
    const user = makeApp('user', makeRegistry({ result: LYRICS }).registry);
    await user.request('/songs/song-1/lyrics/fetch', { method: 'POST' });
    expect(
      await changed(() => user.request('/songs/song-1/lyrics/fetch', { method: 'POST' })),
    ).toEqual([]);
    const miss = makeApp('user', makeRegistry({ result: null }).registry);
    expect(
      await changed(() =>
        miss.request('/songs/song-1/lyrics/fetch', json('POST', { force: true })),
      ),
    ).toEqual([]);
    const untimed = makeApp(
      'user',
      makeRegistry({ result: { plain: 'untimed', synced: null, source: 'lrclib' } }).registry,
    );
    expect(
      await changed(() =>
        untimed.request('/songs/song-1/lyrics/fetch', json('POST', { force: true })),
      ),
    ).toEqual([]);
  });
});

/**
 * #1676: who corrected a row is recorded by the routes that correct it, and the
 * export is the corrected LRC with its provenance — curator-only, read-only.
 */
describe('lyrics provenance and export (#1676)', () => {
  const json = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  beforeEach(() => {
    testDb.run(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'ana', 'h')`);
    seedSong(testDb, 'song-1');
  });

  it('an edit records its author and keeps the fetched origin', async () => {
    const { registry } = makeRegistry({
      result: { ...LYRICS, sourceTrackId: '42', matchedDurationSec: 200, matchedBy: 'exact' },
    });
    await makeApp('user', registry).request('/songs/song-1/lyrics/fetch', { method: 'POST' });
    await makeApp('admin').request('/songs/song-1/lyrics', json('PUT', { plain: 'fixed' }));
    const p = getLyricsProvenance(testDb, 'song-1')!;
    expect(p.customizedBy).toEqual({ userId: 'u1', username: 'ana' });
    expect(p.customizedAt).toEqual(expect.any(Number));
    expect(p.choice).toMatchObject({ source: 'lrclib', sourceTrackId: '42', matchedBy: 'exact' });
  });

  it('a sync records its author', async () => {
    const { registry } = makeRegistry({ result: LYRICS });
    await makeApp('user', registry).request('/songs/song-1/lyrics/fetch', { method: 'POST' });
    await makeApp('admin').request('/songs/song-1/lyrics/offset', json('PATCH', { offsetMs: 500 }));
    expect(getLyricsProvenance(testDb, 'song-1')?.offsetBy).toEqual({
      userId: 'u1',
      username: 'ana',
    });
  });

  it('exports the LRC with the stored offset baked in, plus provenance', async () => {
    const { registry } = makeRegistry({ result: LYRICS });
    await makeApp('user', registry).request('/songs/song-1/lyrics/fetch', { method: 'POST' });
    await makeApp('admin').request('/songs/song-1/lyrics/offset', json('PATCH', { offsetMs: 500 }));

    const res = await makeApp('admin').request('/songs/song-1/lyrics/export');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      songId: 'song-1',
      title: 'Selva',
      artist: 'La Portuaria',
      durationSec: 200,
      synced: '[00:01.50]la selva',
      offsetAppliedMs: 500,
      corrected: true,
      provenance: { source: 'lrclib', offsetBy: { userId: 'u1' }, choice: { timed: true } },
    });
    // Exporting is a read: the stored LRC and its offset are as they were.
    expect(getLyrics(testDb, 'song-1')).toMatchObject({ synced: LYRICS.synced, offsetMs: 500 });
  });

  it('is null when no lyrics are stored, 404 for an unknown song', async () => {
    expect(await (await makeApp('admin').request('/songs/song-1/lyrics/export')).json()).toBeNull();
    expect((await makeApp('admin').request('/songs/nope/lyrics/export')).status).toBe(404);
  });

  it('is curator-only', async () => {
    const { registry } = makeRegistry({ result: LYRICS });
    await makeApp('user', registry).request('/songs/song-1/lyrics/fetch', { method: 'POST' });
    expect((await makeApp('user').request('/songs/song-1/lyrics/export')).status).toBe(403);
  });
});
