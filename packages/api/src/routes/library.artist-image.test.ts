/**
 * Routes + end-to-end serving for the manual artist-image override: upload,
 * copy-from-album, and reset — and that the cover route serves the override ahead
 * of canonical/placeholder. Uses a real temp dataDir (never mocks fs) and mounts
 * both the library and streaming routes so the round-trip is exercised.
 */
import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { JwtPayload } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { applySchema } from '../db.js';
import { libraryRoutes } from './library.js';
import { streamingRoutes } from './streaming.js';
import { clearCoverNegativeCache } from './streaming.js';

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

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

let dataDir: string;

function seed(db: Database): void {
  db.run('INSERT INTO library_artists (id, name, album_count, synced_at) VALUES (?, ?, ?, 1)', [
    'artist-1',
    'Aphex Twin',
    1,
  ]);
  db.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, song_count, synced_at)
     VALUES ('album-1', 'Drukqs', 'Aphex Twin', 'artist-1', 1, 1)`,
  );
}

function makeApp(role: 'admin' | 'user' = 'admin'): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { sub: 'u1', role, iat: 0, exp: 0 } as JwtPayload);
    await next();
  });
  app.route(
    '/',
    libraryRoutes('/music', { dataDir, coverCacheDir: join(dataDir, 'cover-cache') }),
  );
  app.route('/api', streamingRoutes('/music', testDb, dataDir));
  return app;
}

function uploadForm(bytes: Uint8Array, type: string): FormData {
  const form = new FormData();
  // Filename carries an extension matching the type so the multipart part's
  // Content-Type survives the encode/decode round-trip (Bun infers it from the
  // extension), mirroring a real browser file upload.
  const ext = type.split('/')[1] ?? 'bin';
  form.append('image', new Blob([bytes as unknown as BlobPart], { type }), `p.${ext}`);
  return form;
}

beforeEach(() => {
  testDb = new Database(':memory:');
  applySchema(testDb);
  seed(testDb);
  dataDir = mkdtempSync(join(tmpdir(), 'nd-artist-img-'));
  clearCoverNegativeCache(); // isolate from other suites' module-level negative cache
});
afterEach(() => {
  testDb.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('PUT /artists/:id/image (upload)', () => {
  it('stores the upload, flags manual_override, and the cover route then serves it', async () => {
    const app = makeApp();
    const put = await app.request('/artists/artist-1/image', {
      method: 'PUT',
      body: uploadForm(PNG_BYTES, 'image/png'),
    });
    expect(put.status).toBe(200);
    expect(existsSync(join(dataDir, 'artist-overrides', 'artist-1.png'))).toBe(true);
    const flag = testDb
      .query<{ manual_override: number }, [string]>(
        'SELECT manual_override FROM library_artists WHERE id = ?',
      )
      .get('artist-1');
    expect(flag?.manual_override).toBe(1);

    // End-to-end: the cover route serves the override bytes.
    const cover = await app.request('/api/cover/artist-1');
    expect(cover.status).toBe(200);
    expect(cover.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await cover.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it('rejects an unsupported content-type with 415', async () => {
    const res = await makeApp().request('/artists/artist-1/image', {
      method: 'PUT',
      body: uploadForm(PNG_BYTES, 'image/gif'),
    });
    expect(res.status).toBe(415);
  });

  it('404s for an unknown artist', async () => {
    const res = await makeApp().request('/artists/nope/image', {
      method: 'PUT',
      body: uploadForm(PNG_BYTES, 'image/png'),
    });
    expect(res.status).toBe(404);
  });

  it('rejects a non-admin', async () => {
    const res = await makeApp('user').request('/artists/artist-1/image', {
      method: 'PUT',
      body: uploadForm(PNG_BYTES, 'image/png'),
    });
    expect(res.status).toBe(403);
  });
});

describe('POST /artists/:id/image/from-album', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("copies the album's canonical cover into the artist override", async () => {
    // Album has a canonical URL; stub the remote fetch to return image bytes.
    testDb.run(
      `INSERT INTO library_artwork (id, kind, cover_url, updated_at) VALUES ('album-1', 'album', 'https://img/drukqs.png', 1)`,
    );
    globalThis.fetch = (async () =>
      new Response(PNG_BYTES, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })) as unknown as typeof fetch;

    const app = makeApp();
    const res = await app.request('/artists/artist-1/image/from-album', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ albumId: 'album-1' }),
    });
    expect(res.status).toBe(200);
    expect(existsSync(join(dataDir, 'artist-overrides', 'artist-1.png'))).toBe(true);

    const cover = await app.request('/api/cover/artist-1');
    expect(cover.status).toBe(200);
    expect(new Uint8Array(await cover.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it('404s when the album is not the artist’s', async () => {
    testDb.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, synced_at)
       VALUES ('other', 'X', 'Someone', 'artist-2', 1, 1)`,
    );
    const res = await makeApp().request('/artists/artist-1/image/from-album', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ albumId: 'other' }),
    });
    expect(res.status).toBe(404);
  });

  it('400s when the album has no resolvable cover', async () => {
    const res = await makeApp().request('/artists/artist-1/image/from-album', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ albumId: 'album-1' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /artists/:id/image (reset)', () => {
  it('removes the override, clears the flag, and the cover route 404s again', async () => {
    const app = makeApp();
    await app.request('/artists/artist-1/image', {
      method: 'PUT',
      body: uploadForm(PNG_BYTES, 'image/png'),
    });
    const del = await app.request('/artists/artist-1/image', { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(existsSync(join(dataDir, 'artist-overrides', 'artist-1.png'))).toBe(false);
    const flag = testDb
      .query<{ manual_override: number }, [string]>(
        'SELECT manual_override FROM library_artists WHERE id = ?',
      )
      .get('artist-1');
    expect(flag?.manual_override).toBe(0);

    // No override, no canonical, no disk art → placeholder (404).
    const cover = await app.request('/api/cover/artist-1');
    expect(cover.status).toBe(404);
  });
});
