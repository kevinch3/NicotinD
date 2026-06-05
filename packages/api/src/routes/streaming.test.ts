import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { streamingRoutes } from './streaming.js';
import { applySchema } from '../db.js';

let musicDir: string;
let dataDir: string;
let db: Database;
let app: Hono;

const AUDIO_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

function seedSong(id: string, relPath: string): void {
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, synced_at)
     VALUES (?, 'alb', 'T', 'A', 'art', 0, ?, 10, 320, 'mp3', 'audio/mpeg', '2024-01-01', 1)`,
    [id, relPath],
  );
}

beforeAll(() => {
  musicDir = mkdtempSync(join(tmpdir(), 'nd-music-'));
  dataDir = mkdtempSync(join(tmpdir(), 'nd-data-'));
  db = new Database(':memory:');
  applySchema(db);

  // Song with embedded-free file + a folder cover.jpg alongside it.
  mkdirSync(join(musicDir, 'Artist', 'Album'), { recursive: true });
  writeFileSync(join(musicDir, 'Artist', 'Album', 'song.mp3'), AUDIO_BYTES);
  writeFileSync(join(musicDir, 'Artist', 'Album', 'cover.jpg'), JPEG_BYTES);
  seedSong('song-1', 'Artist/Album/song.mp3');

  // Song whose folder has no cover art.
  mkdirSync(join(musicDir, 'NoArt'), { recursive: true });
  writeFileSync(join(musicDir, 'NoArt', 'bare.mp3'), AUDIO_BYTES);
  seedSong('song-2', 'NoArt/bare.mp3');

  app = new Hono();
  app.route('/', streamingRoutes(musicDir, db, dataDir));
});

afterAll(() => {
  rmSync(musicDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('streaming routes', () => {
  it('serves the full file with a 200 and accept-ranges', async () => {
    const res = await app.request('/stream/song-1');
    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf.length).toBe(10);
  });

  it('honours a range request with 206 and the correct slice', async () => {
    const res = await app.request('/stream/song-1', { headers: { range: 'bytes=2-5' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10');
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(buf)).toEqual([3, 4, 5, 6]);
  });

  it('returns 416 for an unsatisfiable range', async () => {
    const res = await app.request('/stream/song-1', { headers: { range: 'bytes=99-200' } });
    expect(res.status).toBe(416);
  });

  it('returns 404 when the song id is unknown', async () => {
    const res = await app.request('/stream/missing');
    expect(res.status).toBe(404);
  });

  it('serves a folder cover.jpg as the cover art with a browser cache header', async () => {
    const res = await app.request('/cover/song-1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    // Successful covers must be browser-cacheable so navigation stops re-fetching
    // every tile (the connection-pool pressure behind slow album pages).
    expect(res.headers.get('cache-control')).toContain('max-age');
  });

  it('returns 404 when no cover art is available', async () => {
    const res = await app.request('/cover/song-2');
    expect(res.status).toBe(404);
  });

  it('returns 404 cover for an unknown id', async () => {
    const res = await app.request('/cover/missing');
    expect(res.status).toBe(404);
  });

  it('resolves an album cover from track 1 deterministically (not an arbitrary row)', async () => {
    // Track 2 sits in a folder that sorts FIRST alphabetically and has no art;
    // track 1 sits in a later-sorting folder that holds the real cover. Ordering
    // by track (not path/insertion) must pick track 1 so the album shows the
    // right thumbnail even though other tracks/folders differ.
    mkdirSync(join(musicDir, 'Aaa wrong'), { recursive: true });
    writeFileSync(join(musicDir, 'Aaa wrong', '02.mp3'), AUDIO_BYTES);
    mkdirSync(join(musicDir, 'Zzz right'), { recursive: true });
    writeFileSync(join(musicDir, 'Zzz right', '01.mp3'), AUDIO_BYTES);
    writeFileSync(join(musicDir, 'Zzz right', 'cover.jpg'), JPEG_BYTES);
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, track, duration, path, size, bit_rate, suffix, content_type, created, synced_at)
       VALUES ('multi-2', 'multi', 'Two', 'A', 'art', 2, 0, 'Aaa wrong/02.mp3', 10, 320, 'mp3', 'audio/mpeg', '2024-01-01', 1),
              ('multi-1', 'multi', 'One', 'A', 'art', 1, 0, 'Zzz right/01.mp3', 10, 320, 'mp3', 'audio/mpeg', '2024-01-01', 1)`,
    );

    const res = await app.request('/cover/multi');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
  });
});

describe('streaming routes — canonical artwork', () => {
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const realFetch = globalThis.fetch;
  let fetchCalls: string[];
  let fetchOk = true;

  beforeAll(() => {
    // 'canon-alb' has a canonical URL but its file has no on-disk art.
    mkdirSync(join(musicDir, 'CanonArtist', 'CanonAlbum'), { recursive: true });
    writeFileSync(join(musicDir, 'CanonArtist', 'CanonAlbum', 't.mp3'), AUDIO_BYTES);
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, synced_at)
       VALUES ('song-canon', 'canon-alb', 'T', 'A', 'canon-art', 0, 'CanonArtist/CanonAlbum/t.mp3', 10, 320, 'mp3', 'audio/mpeg', '2024-01-01', 1)`,
    );
    db.run(
      `INSERT INTO library_artwork (id, kind, cover_url, updated_at)
       VALUES ('canon-alb', 'album', 'https://art.example/cover.png', 1),
              ('art', 'artist', 'https://art.example/poster.png', 1)`,
    );

    fetchCalls = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      if (!fetchOk) return new Response(null, { status: 404 });
      return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } });
    }) as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  it('prefers canonical artwork over on-disk art for an album id', async () => {
    fetchOk = true;
    fetchCalls = [];
    const res = await app.request('/cover/canon-alb');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toContain('max-age');
    expect(fetchCalls).toContain('https://art.example/cover.png');
  });

  it('resolves a song id to its album canonical artwork', async () => {
    fetchOk = true;
    const res = await app.request('/cover/song-canon');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
  });

  it('serves an artist poster for an artist id', async () => {
    fetchOk = true;
    fetchCalls = [];
    const res = await app.request('/cover/art');
    expect(res.status).toBe(200);
    expect(fetchCalls).toContain('https://art.example/poster.png');
  });

  it('falls back to on-disk folder art when the canonical fetch fails', async () => {
    // 'alb' (song-1) has a folder cover.jpg; give it a dead canonical URL.
    db.run(
      `INSERT INTO library_artwork (id, kind, cover_url, updated_at) VALUES ('alb', 'album', 'https://dead.example/x.png', 1)`,
    );
    fetchOk = false;
    const res = await app.request('/cover/song-1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    db.run(`DELETE FROM library_artwork WHERE id = 'alb'`);
  });
});
