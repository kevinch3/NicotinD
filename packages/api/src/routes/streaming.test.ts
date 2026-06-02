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

  it('serves a folder cover.jpg as the cover art', async () => {
    const res = await app.request('/cover/song-1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
  });

  it('returns 404 when no cover art is available', async () => {
    const res = await app.request('/cover/song-2');
    expect(res.status).toBe(404);
  });

  it('returns 404 cover for an unknown id', async () => {
    const res = await app.request('/cover/missing');
    expect(res.status).toBe(404);
  });
});
