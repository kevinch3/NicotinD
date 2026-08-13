import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { streamingRoutes } from './streaming.js';
import { applySchema } from '../db.js';
import {
  transcodeCacheKey,
  _pinRefcountForTests,
  _resetTranscodeCacheForTests,
} from '../services/transcode-cache.js';
import { _resetFfmpegProbe } from '../services/transcode.js';

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

  it('keeps streams seekable (206) even with force-transcode enabled', async () => {
    // Transcoding the fake (non-audio) bytes fails, so the route must fall back
    // to a range-served passthrough rather than a non-seekable 200 pipe. (Where
    // ffmpeg is absent the branch is skipped entirely — same seekable outcome.)
    db.run(
      `INSERT INTO app_settings (key, value) VALUES ('streaming', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [
        JSON.stringify({
          transcodeEnabled: true,
          forceTranscode: true,
          format: 'mp3',
          maxBitRate: 192,
        }),
      ],
    );
    try {
      const res = await app.request('/stream/song-1', { headers: { range: 'bytes=2-5' } });
      expect(res.status).toBe(206);
      expect(res.headers.get('accept-ranges')).toBe('bytes');
      expect(res.headers.get('content-range')).toBe('bytes 2-5/10');
    } finally {
      db.run(`DELETE FROM app_settings WHERE key = 'streaming'`);
    }
  });

  it('accepts ?vocals=off and stays seekable even with transcoding disabled', async () => {
    // Vocal mute must force the transcode path regardless of the transcodeEnabled
    // setting. Transcoding the fake (non-audio) bytes fails (or ffmpeg is absent),
    // so the route degrades to a range-served passthrough — never a broken stream.
    db.run(
      `INSERT INTO app_settings (key, value) VALUES ('streaming', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [
        JSON.stringify({
          transcodeEnabled: false,
          forceTranscode: false,
          format: 'mp3',
          maxBitRate: 192,
        }),
      ],
    );
    try {
      const res = await app.request('/stream/song-1?vocals=off', {
        headers: { range: 'bytes=2-5' },
      });
      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe('bytes 2-5/10');
    } finally {
      db.run(`DELETE FROM app_settings WHERE key = 'streaming'`);
    }
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

  it('serves a resized webp thumbnail for ?size= and caches the variant', async () => {
    // A real (decodable) PNG folder cover so the resize actually runs.
    const sharp = (await import('sharp')).default;
    const png = await sharp({
      create: { width: 600, height: 600, channels: 3, background: { r: 10, g: 120, b: 200 } },
    })
      .png()
      .toBuffer();
    mkdirSync(join(musicDir, 'ThumbArtist', 'ThumbAlbum'), { recursive: true });
    writeFileSync(join(musicDir, 'ThumbArtist', 'ThumbAlbum', 't.mp3'), AUDIO_BYTES);
    writeFileSync(join(musicDir, 'ThumbArtist', 'ThumbAlbum', 'cover.png'), png);
    seedSong('song-thumb', 'ThumbArtist/ThumbAlbum/t.mp3');

    const res = await app.request('/cover/song-thumb?size=80');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    const buf = new Uint8Array(await res.arrayBuffer());
    const meta = await sharp(Buffer.from(buf)).metadata();
    expect(meta.width).toBe(80); // 300 (grid) → bucket, 80 stays 80
    // The resized variant is written to the cover cache for fast repeat hits.
    // That write is fire-and-forget (`void cacheCover(...)` — the route responds
    // before the cache lands), so poll briefly instead of racing it: a plain
    // existsSync right after the response flakes on loaded CI runners.
    const cached = join(dataDir, 'cover-cache', 'song-thumb@80.webp');
    const deadline = Date.now() + 2000;
    while (!existsSync(cached) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(existsSync(cached)).toBe(true);
  });

  it('serves the original (not a thumbnail) when no size is requested', async () => {
    const res = await app.request('/cover/song-thumb');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
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

  it('keeps a failed-transcode fallback response Content-Length/Range intact', async () => {
    // The transcode here fails (fake audio bytes, or ffmpeg absent) and the
    // route falls back to the original passthrough — the wire format must
    // remain intact (Content-Length on 200, Content-Range on 206, no
    // transfer-encoding) so browsers can keep using duration from the
    // container parse. The successful transcode-cache path has its own
    // wire-contract suite below (it needs a real Bun.serve socket).
    db.run(
      `INSERT INTO app_settings (key, value) VALUES ('streaming', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [
        JSON.stringify({
          transcodeEnabled: true,
          forceTranscode: true,
          format: 'mp3',
          maxBitRate: 192,
        }),
      ],
    );
    try {
      const res = await app.request('/stream/song-1');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-length')).toBe('10');
      expect(res.headers.get('transfer-encoding')).toBeNull();
      expect(res.headers.get('accept-ranges')).toBe('bytes');
    } finally {
      db.run(`DELETE FROM app_settings WHERE key = 'streaming'`);
    }
  });

  it('returns 404 for an artist id with no canonical artwork (no album-cover fallback)', async () => {
    // The artist's only track sits in a folder that DOES have a cover.jpg. Before
    // this change the cover route fell back to that representative track's folder
    // art, painting the artist with a (often misleading) album cover. Now an
    // artist id resolves to null → 404 → the UI shows the neutral initial tile.
    // (A distinct artist_id, never reused with canonical artwork below, so the
    // module-level negative-cache 404 can't leak into the poster suite.)
    mkdirSync(join(musicDir, 'LoneArtist', 'LoneAlbum'), { recursive: true });
    writeFileSync(join(musicDir, 'LoneArtist', 'LoneAlbum', 'l.mp3'), AUDIO_BYTES);
    writeFileSync(join(musicDir, 'LoneArtist', 'LoneAlbum', 'cover.jpg'), JPEG_BYTES);
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, synced_at)
       VALUES ('lone-1', 'lone-alb', 'L', 'Lone', 'lone-art', 0, 'LoneArtist/LoneAlbum/l.mp3', 10, 320, 'mp3', 'audio/mpeg', '2024-01-01', 1)`,
    );

    // The album id still resolves to the folder cover (sanity: only the artist
    // path changed), …
    expect((await app.request('/cover/lone-alb')).status).toBe(200);
    // … but the artist id does not.
    expect((await app.request('/cover/lone-art')).status).toBe(404);
  });
});

describe('streaming routes — range parsing (RFC 9110)', () => {
  // File is AUDIO_BYTES = [1..10] (10 bytes). iOS Safari's media loader
  // (CoreMedia) probes container tail metadata with suffix ranges; serving the
  // HEAD of the file for `bytes=-N` (the old parse: start=0, end=N) hands back
  // wrong bytes under a mismatched Content-Range, and Safari re-requests
  // forever — track metadata loads, the song never finishes loading.
  it('serves a suffix range (bytes=-N) as the LAST N bytes', async () => {
    const res = await app.request('/stream/song-1', { headers: { range: 'bytes=-4' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 6-9/10');
    expect(res.headers.get('content-length')).toBe('4');
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(buf)).toEqual([7, 8, 9, 10]);
  });

  it('clamps an over-long suffix range to the whole file', async () => {
    const res = await app.request('/stream/song-1', { headers: { range: 'bytes=-999' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-9/10');
    expect(new Uint8Array(await res.arrayBuffer()).length).toBe(10);
  });

  it('rejects a zero-length suffix range (bytes=-0) with 416', async () => {
    const res = await app.request('/stream/song-1', { headers: { range: 'bytes=-0' } });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */10');
  });

  it('ignores a malformed bytes=- range and serves the full file as 200', async () => {
    const res = await app.request('/stream/song-1', { headers: { range: 'bytes=-' } });
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer()).length).toBe(10);
  });

  it('still serves an open-ended range (bytes=N-) to the end of the file', async () => {
    const res = await app.request('/stream/song-1', { headers: { range: 'bytes=6-' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 6-9/10');
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([7, 8, 9, 10]);
  });
});

describe('streaming routes — wire contract over a real socket', () => {
  // In-process `app.request()` cannot catch the regression these tests guard:
  // Bun drops an explicitly-set Content-Length and switches to
  // `Transfer-Encoding: chunked` at *wire serialization time* whenever the
  // response body is a bare ReadableStream instead of a Blob. A chunked 206
  // stalls Firefox's and iOS Safari's media loaders forever (metadata loads,
  // the song never finishes loading), so these run through a real Bun.serve
  // socket where the wire behaviour is observable.
  const TRUE_BIN = existsSync('/usr/bin/true') ? '/usr/bin/true' : '/bin/true';
  let server: ReturnType<typeof Bun.serve> | null = null;
  let prevFfmpegPath: string | undefined;

  beforeAll(() => {
    prevFfmpegPath = process.env.NICOTIND_FFMPEG_PATH;
    server = Bun.serve({ port: 0, fetch: app.fetch });
  });

  afterAll(() => {
    server?.stop();
    if (prevFfmpegPath === undefined) delete process.env.NICOTIND_FFMPEG_PATH;
    else process.env.NICOTIND_FFMPEG_PATH = prevFfmpegPath;
    _resetFfmpegProbe();
    _resetTranscodeCacheForTests();
  });

  const wireUrl = (path: string) => `http://127.0.0.1:${server!.port}${path}`;

  it('passthrough responses carry Content-Length on the wire (200 and 206)', async () => {
    const full = await fetch(wireUrl('/stream/song-1'));
    expect(full.status).toBe(200);
    expect(full.headers.get('content-length')).toBe('10');
    expect(full.headers.get('transfer-encoding')).toBeNull();
    await full.arrayBuffer();

    const partial = await fetch(wireUrl('/stream/song-1'), { headers: { range: 'bytes=2-5' } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-length')).toBe('4');
    expect(partial.headers.get('transfer-encoding')).toBeNull();
    await partial.arrayBuffer();
  });

  it('a transcode-cache hit keeps Content-Length on the wire and pins the file', async () => {
    // Hermetic transcode path: point the ffmpeg probe at /usr/bin/true so
    // `ffmpegAvailable()` is true without ffmpeg, and pre-seed a usable cache
    // file at the exact key the route computes — `getTranscodedFile` then
    // returns the seeded file without ever spawning a transcoder.
    mkdirSync(join(musicDir, 'Pin'), { recursive: true });
    const srcRel = 'Pin/pin.mp3';
    writeFileSync(join(musicDir, srcRel), AUDIO_BYTES);
    seedSong('song-pin', srcRel);

    const abs = resolve(join(resolve(musicDir), srcRel));
    const st = statSync(abs);
    const key = transcodeCacheKey(abs, st.mtimeMs, st.size, 'mp3', 192, false);
    const cacheDir = join(dataDir, 'transcode-cache');
    mkdirSync(cacheDir, { recursive: true });
    const cachePath = join(cacheDir, `${key}.mp3`);
    writeFileSync(cachePath, new Uint8Array(2048).fill(7));

    process.env.NICOTIND_FFMPEG_PATH = TRUE_BIN;
    _resetFfmpegProbe();
    db.run(
      `INSERT INTO app_settings (key, value) VALUES ('streaming', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [
        JSON.stringify({
          transcodeEnabled: true,
          forceTranscode: true,
          format: 'mp3',
          maxBitRate: 192,
        }),
      ],
    );
    try {
      const full = await fetch(wireUrl('/stream/song-pin'));
      expect(full.status).toBe(200);
      expect(full.headers.get('content-type')).toBe('audio/mpeg');
      // 2048 = the seeded cache file, NOT the 10-byte original: proof the
      // transcode-cache path (the pinned one) actually served this response.
      expect(full.headers.get('content-length')).toBe('2048');
      expect(full.headers.get('transfer-encoding')).toBeNull();
      expect(new Uint8Array(await full.arrayBuffer()).length).toBe(2048);

      const partial = await fetch(wireUrl('/stream/song-pin'), {
        headers: { range: 'bytes=0-1' },
      });
      expect(partial.status).toBe(206);
      expect(partial.headers.get('content-range')).toBe('bytes 0-1/2048');
      expect(partial.headers.get('content-length')).toBe('2');
      expect(partial.headers.get('transfer-encoding')).toBeNull();
      await partial.arrayBuffer();

      const suffix = await fetch(wireUrl('/stream/song-pin'), {
        headers: { range: 'bytes=-100' },
      });
      expect(suffix.status).toBe(206);
      expect(suffix.headers.get('content-range')).toBe('bytes 1948-2047/2048');
      await suffix.arrayBuffer();

      // The pin is grace-timed (60s default), so it is still held here — the
      // prune cannot unlink the file before Bun opened it.
      expect(_pinRefcountForTests(cachePath)).toBeGreaterThan(0);
    } finally {
      db.run(`DELETE FROM app_settings WHERE key = 'streaming'`);
      if (prevFfmpegPath === undefined) delete process.env.NICOTIND_FFMPEG_PATH;
      else process.env.NICOTIND_FFMPEG_PATH = prevFfmpegPath;
      _resetFfmpegProbe();
      _resetTranscodeCacheForTests();
    }
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
