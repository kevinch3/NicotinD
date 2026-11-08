/**
 * Regression tests for #1666 Shape A: a cover image whose bytes change under an
 * unchanged URL.
 *
 * A bare `/api/cover/<id>` is served `max-age=86400` (a versioned one for a
 * year, immutable), and the client builds that URL
 * from entity data alone (`coverArt`, which is the bare entity id). So the
 * invariant every cover writer must keep is: **the entity's cover identity —
 * every `cover*` field the DTO carries — changes whenever the bytes do.**
 * Otherwise a browser that already holds the old bytes serves them for a day
 * without asking, on every surface, across reloads.
 *
 * Each test proves the bytes changed (different content ETag) and then asserts
 * the identity the client sees changed with them. The identity comparison is
 * deliberately shape-agnostic: it reads whatever `cover*` fields the DTO has,
 * so a `coverRev` / `coverArt: "<id>~<rev>"` / similar fix all satisfy it.
 */
import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { JwtPayload } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { applySchema } from '../db.js';
import { libraryRoutes } from './library.js';
import { streamingRoutes, clearCoverNegativeCache } from './streaming.js';
import { libraryEvents, type StampedEvent } from '../services/library-events.js';
import { setArtwork } from '../services/artwork-store.js';

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

let dataDir: string;
let musicDir: string;

function seed(db: Database): void {
  db.run('INSERT INTO library_artists (id, name, album_count, synced_at) VALUES (?, ?, ?, 1)', [
    'artist-1',
    'Aphex Twin',
    1,
  ]);
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

function makeApp(): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { sub: 'u1', role: 'admin', iat: 0, exp: 0 } as JwtPayload);
    await next();
  });
  app.route('/', libraryRoutes(musicDir, { dataDir, coverCacheDir: join(dataDir, 'cover-cache') }));
  app.route('/api', streamingRoutes(musicDir, testDb, dataDir));
  return app;
}

async function png(r: number, g: number, b: number, size = 64): Promise<Uint8Array> {
  const sharp = (await import('sharp')).default;
  const out = await sharp({
    create: { width: size, height: size, channels: 3, background: { r, g, b } },
  })
    .png()
    .toBuffer();
  return new Uint8Array(out);
}

function uploadForm(bytes: Uint8Array): FormData {
  const form = new FormData();
  form.append('image', new Blob([bytes as unknown as BlobPart], { type: 'image/png' }), 'p.png');
  return form;
}

/** Every `cover*` field of a DTO: what a client can build an image URL from. */
function coverIdentity(dto: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(dto).filter(([k]) => k.startsWith('cover')));
}

async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T;
}

async function etagOf(app: Hono<AuthEnv>, path: string): Promise<string | null> {
  const res = await app.request(path);
  expect(res.status).toBe(200);
  // The header policy is pinned in streaming.test.ts (#1666 A4); here the
  // identity assertion is the contract.
  return res.headers.get('etag');
}

/** Collect every library event delivered while `fn` runs (coalescing flushed). */
async function eventsDuring(fn: () => Promise<void>): Promise<StampedEvent[]> {
  const seen: StampedEvent[] = [];
  const off = libraryEvents.on((e) => seen.push(e));
  try {
    await fn();
    libraryEvents.flush();
  } finally {
    off();
  }
  return seen;
}

/** Every `{kind, id, rev}` an `artwork.changed` frame carried, in delivery order. */
function artworkChanges(events: StampedEvent[]): unknown[] {
  return events.flatMap((e) =>
    e.event.type === 'artwork.changed' ? (e.event as { changes: unknown[] }).changes : [],
  );
}

beforeEach(() => {
  testDb = new Database(':memory:');
  applySchema(testDb);
  seed(testDb);
  dataDir = mkdtempSync(join(tmpdir(), 'nd-cover-identity-'));
  musicDir = mkdtempSync(join(tmpdir(), 'nd-cover-identity-music-'));
  mkdirSync(join(musicDir, 'Aphex Twin', 'Drukqs'), { recursive: true });
  writeFileSync(
    join(musicDir, 'Aphex Twin', 'Drukqs', '01 - Avril 14th.flac'),
    new Uint8Array([1, 2, 3]),
  );
  clearCoverNegativeCache();
  libraryEvents.flush();
});
afterEach(() => {
  testDb.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(musicDir, { recursive: true, force: true });
});

describe('#1666 artist portrait: cover identity travels with the bytes', () => {
  async function uploadPortrait(app: Hono<AuthEnv>, bytes: Uint8Array): Promise<void> {
    const res = await app.request('/artists/artist-1/image', {
      method: 'PUT',
      body: uploadForm(bytes),
    });
    expect(res.status).toBe(200);
  }

  it('replacing a portrait changes the artist DTO cover identity (GET /artists/:id)', async () => {
    const app = makeApp();
    await uploadPortrait(app, await png(255, 0, 0));
    const etagBefore = await etagOf(app, '/api/cover/artist-1?size=200');
    const before = await json<{ artist: Record<string, unknown> }>(
      app.request('/artists/artist-1'),
    );

    await uploadPortrait(app, await png(0, 0, 255));
    const etagAfter = await etagOf(app, '/api/cover/artist-1?size=200');
    const after = await json<{ artist: Record<string, unknown> }>(app.request('/artists/artist-1'));

    expect(etagAfter).not.toBe(etagBefore); // precondition: the bytes did change
    expect(coverIdentity(after.artist)).not.toEqual(coverIdentity(before.artist));
  });

  it('replacing a portrait changes the cover identity the Artists grid reads (GET /artists)', async () => {
    const app = makeApp();
    await uploadPortrait(app, await png(255, 0, 0));
    type ArtistsList = Array<{ id: string } & Record<string, unknown>>;
    const pick = (list: unknown) =>
      (
        (Array.isArray(list) ? list : (list as { artists: ArtistsList }).artists) as ArtistsList
      ).find((a) => a.id === 'artist-1')!;
    const before = pick(await json(app.request('/artists')));

    await uploadPortrait(app, await png(0, 0, 255));
    const after = pick(await json(app.request('/artists')));

    expect(coverIdentity(after)).not.toEqual(coverIdentity(before));
  });

  it('resetting a portrait changes the artist DTO cover identity', async () => {
    const app = makeApp();
    await uploadPortrait(app, await png(255, 0, 0));
    const before = await json<{ artist: Record<string, unknown> }>(
      app.request('/artists/artist-1'),
    );

    const del = await app.request('/artists/artist-1/image', { method: 'DELETE' });
    expect(del.status).toBe(200);
    const after = await json<{ artist: Record<string, unknown> }>(app.request('/artists/artist-1'));

    expect(coverIdentity(after.artist)).not.toEqual(coverIdentity(before.artist));
  });

  it('a portrait change is published as artwork.changed, carrying the persisted rev', async () => {
    const app = makeApp();
    const bytes = await png(0, 255, 0);
    const events = await eventsDuring(() => uploadPortrait(app, bytes));
    const { artist } = await json<{ artist: Record<string, unknown> }>(
      app.request('/artists/artist-1'),
    );
    // Album covers emit `artwork.changed`; an artist portrait emitted nothing, so no
    // open tab other than the one that made the change could ever hear about it.
    expect(artworkChanges(events)).toContainEqual({
      kind: 'artist',
      id: 'artist-1',
      rev: artist.coverRev,
    });
    expect(typeof artist.coverRev).toBe('number');
  });

  // The acting client re-keys its portrait URL from the response (A2), so the
  // answer must be the rev the DTO now carries, not just `ok`.
  it('every portrait mutation answers the rev the artist DTO now carries', async () => {
    const app = makeApp();
    const revNow = async () =>
      (await json<{ artist: { coverRev: number } }>(app.request('/artists/artist-1'))).artist
        .coverRev;

    const put = await json<{ ok: boolean; coverRev: number }>(
      app.request('/artists/artist-1/image', {
        method: 'PUT',
        body: uploadForm(await png(255, 0, 0)),
      }),
    );
    expect(put.coverRev).toBe(await revNow());
    expect(put.coverRev).toBeGreaterThan(0);

    const del = await json<{ ok: boolean; coverRev: number }>(
      app.request('/artists/artist-1/image', { method: 'DELETE' }),
    );
    expect(del.coverRev).toBe(await revNow());
    expect(del.coverRev).toBeGreaterThan(put.coverRev);
  });
});

describe('#1666 album cover: cover identity travels with the bytes', () => {
  async function uploadCover(app: Hono<AuthEnv>, bytes: Uint8Array): Promise<void> {
    const res = await app.request('/albums/album-1/cover', {
      method: 'PUT',
      body: uploadForm(bytes),
    });
    expect(res.status).toBe(200);
  }

  it('an uploaded album cover changes the album and song DTO cover identity', async () => {
    const app = makeApp();
    await uploadCover(app, await png(255, 0, 0, 300));
    const etagBefore = await etagOf(app, '/api/cover/album-1?size=300');
    const before = await json<Record<string, unknown> & { song: Record<string, unknown>[] }>(
      app.request('/albums/album-1'),
    );

    await uploadCover(app, await png(0, 0, 255, 300));
    const etagAfter = await etagOf(app, '/api/cover/album-1?size=300');
    const after = await json<Record<string, unknown> & { song: Record<string, unknown>[] }>(
      app.request('/albums/album-1'),
    );

    expect(etagAfter).not.toBe(etagBefore); // precondition: the bytes did change
    expect(coverIdentity(after)).not.toEqual(coverIdentity(before));
    // Track rows, the player bar and Now Playing build their URL from the song's coverArt.
    expect(coverIdentity(after.song[0]!)).not.toEqual(coverIdentity(before.song[0]!));
  });

  it('an uploaded album cover is published as artwork.changed, like the picker apply is', async () => {
    const app = makeApp();
    const bytes = await png(0, 255, 0, 300);
    const events = await eventsDuring(() => uploadCover(app, bytes));
    const album = await json<Record<string, unknown>>(app.request('/albums/album-1'));
    // POST /albums/:id/cover (applyAlbumCover) emitted it; the PUT upload route did not.
    expect(artworkChanges(events)).toContainEqual({
      kind: 'album',
      id: 'album-1',
      rev: album.coverRev,
    });
    expect(typeof album.coverRev).toBe('number');
  });

  it('an artless album that gains a cover is served at once, not after the negative cache', async () => {
    const app = makeApp();
    // Ask while the album is artless: both ids are 404-cached for NO_ART_TTL_MS.
    expect((await app.request('/api/cover/album-1?size=300')).status).toBe(404);
    expect((await app.request('/api/cover/song-1?size=300')).status).toBe(404);

    const bytes = await png(10, 20, 30, 300);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(bytes as unknown as BodyInit, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })) as unknown as typeof fetch;
    try {
      // A service-layer writer (enrichment, discography, backfill all call this),
      // not a route: the eviction has to come with the write itself.
      setArtwork(
        testDb,
        'album-1',
        'album',
        'https://img/drukqs.jpg',
        join(dataDir, 'cover-cache'),
      );
      expect((await app.request('/api/cover/album-1?size=300')).status).toBe(200);
      expect((await app.request('/api/cover/song-1?size=300')).status).toBe(200);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
