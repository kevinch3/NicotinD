import { Hono } from 'hono';
import { join, resolve, dirname, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { getStreamingSettings } from '../services/streaming-settings.js';
import { ffmpegAvailable, transcodeContentType } from '../services/transcode.js';
import { getTranscodedFile } from '../services/transcode-cache.js';
import { getMusicMetadata } from '../services/music-metadata-loader.js';
import { resolveArtwork, canonicalCacheKey } from '../services/artwork-store.js';

const log = createLogger('streaming');

const COVER_FILE_NAMES = ['cover', 'folder', 'front', 'album', 'albumart'];
const COVER_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];

// id → expiry epoch ms. Short-circuits extractCover() disk IO for artless albums.
// Keyed by album/artist/song id; cleared automatically when TTL expires.
const noArtCache = new Map<string, number>();
const NO_ART_TTL_MS = 10 * 60 * 1_000;

// Cap on remote canonical-cover fetches so a slow/dead host can't hang a connection.
const REMOTE_COVER_TIMEOUT_MS = 6_000;
// Successful covers are immutable per id within a session — let the browser cache
// them so navigating between pages stops re-requesting every tile from the server.
const COVER_CACHE_CONTROL = 'public, max-age=86400';

/** Evict the negative-art cache for a given id (e.g. after artwork is backfilled). */
export function clearCoverNegativeCache(id?: string): void {
  if (id) noArtCache.delete(id);
  else noArtCache.clear();
}

/**
 * Native streaming + cover art. Replaces the Navidrome media proxy: serves file
 * bytes straight from disk (with HTTP range support) and resolves cover art from
 * folder images or embedded tags. Optional ffmpeg transcoding is gated by the
 * admin streaming settings.
 */
export function streamingRoutes(musicDir: string, db: Database, dataDir: string) {
  const app = new Hono<AuthEnv>();
  const musicRoot = resolve(musicDir);
  const coverCacheDir = join(dataDir, 'cover-cache');
  const transcodeCacheDir = join(dataDir, 'transcode-cache');

  /** Resolve a library id (song id, or album id) to an absolute, in-root path. */
  function resolvePath(id: string): string | null {
    let row = db
      .query<{ path: string }, [string]>('SELECT path FROM library_songs WHERE id = ?')
      .get(id);
    if (!row) {
      // Album/artist cover ids point at a representative song. Pick the album's
      // FIRST track (lowest disc/track) deterministically rather than an arbitrary
      // row: track 1 lives in the canonical album folder, so its folder image is
      // the album's real cover. why: an unordered `LIMIT 1` could land on a
      // mislabeled/wrong-source file in the same folder, giving the album the
      // wrong thumbnail even while individual tracks show correct embedded art.
      // (Foreign rips are already excluded from library_songs by the scanner's
      // track selection, which further narrows this to real album tracks.)
      row =
        db
          .query<{ path: string }, [string]>(
            `SELECT path FROM library_songs WHERE album_id = ?
             ORDER BY COALESCE(disc, 1), COALESCE(track, 999999), path LIMIT 1`,
          )
          .get(id) ??
        db
          .query<
            { path: string },
            [string]
          >('SELECT path FROM library_songs WHERE artist_id = ? ORDER BY path LIMIT 1')
          .get(id);
    }
    if (!row) return null;
    const abs = resolve(join(musicRoot, row.path));
    if (abs !== musicRoot && !abs.startsWith(musicRoot + sep)) return null; // traversal guard
    if (!existsSync(abs)) return null;
    return abs;
  }

  app.get('/stream/:id', async (c) => {
    const id = c.req.param('id');
    const abs = resolvePath(id);
    if (!abs) return c.body(null, 404);

    const settings = getStreamingSettings(db);
    const reqFormat = c.req.query('format');
    const reqBitRate = c.req.query('maxBitRate') ? Number(c.req.query('maxBitRate')) : undefined;
    const wantsTranscode =
      settings.transcodeEnabled &&
      ffmpegAvailable() &&
      (settings.forceTranscode || (reqFormat && reqFormat !== 'raw') || reqBitRate != null);

    const range = c.req.header('range');

    if (wantsTranscode) {
      const format =
        reqFormat && reqFormat !== 'raw' && reqFormat !== 'original'
          ? (reqFormat as 'mp3' | 'opus' | 'aac')
          : settings.format;
      const kbps = reqBitRate && reqBitRate > 0 ? reqBitRate : settings.maxBitRate;
      try {
        // Transcode to a cached file (once) and serve THAT with range support, so
        // transcoded streams are seekable. A sequential ffmpeg pipe (status 200,
        // no content-length / accept-ranges) can't be seeked, which is why far
        // seeks did nothing on iOS/Firefox when transcoding was on.
        const cached = await getTranscodedFile(transcodeCacheDir, abs, format, kbps);
        return serveFileWithRange(cached, range, transcodeContentType(format));
      } catch (err) {
        log.error({ err, abs }, 'transcode failed; falling back to original');
        // fall through to passthrough
      }
    }

    // Passthrough with HTTP range support.
    return serveFileWithRange(abs, range);
  });

  app.get('/cover/:id', async (c) => {
    const id = c.req.param('id');

    // Fast-path: id was already checked and found artless within the TTL.
    if ((noArtCache.get(id) ?? 0) > Date.now()) {
      return new Response(null, {
        status: 404,
        headers: { 'cache-control': 'public, max-age=300' },
      });
    }

    // 1. Canonical (Lidarr/MusicBrainz) artwork takes precedence so the app
    //    matches the hunt tool, and so artists get real poster images. Cached
    //    under a `c_<key>` namespace, shared across an album's songs.
    const canonical = resolveArtwork(db, id);
    if (canonical) {
      const cacheKey = canonicalCacheKey(canonical.key);
      const cached = await readCachedCover(coverCacheDir, cacheKey);
      if (cached) {
        return new Response(toBody(cached.data), {
          headers: { 'content-type': cached.contentType, 'cache-control': COVER_CACHE_CONTROL },
        });
      }
      const remote = await fetchRemoteCover(canonical.url);
      if (remote) {
        void cacheCover(coverCacheDir, cacheKey, remote).catch((err) =>
          log.debug({ err, id }, 'canonical cover cache write failed'),
        );
        return new Response(toBody(remote.data), {
          headers: { 'content-type': remote.contentType, 'cache-control': COVER_CACHE_CONTROL },
        });
      }
      // Remote fetch failed (offline / dead URL) — fall through to on-disk art.
    }

    // 2. On-disk art (folder image, then embedded tag).
    const cached = await readCachedCover(coverCacheDir, id);
    if (cached) {
      return new Response(toBody(cached.data), {
        headers: { 'content-type': cached.contentType, 'cache-control': COVER_CACHE_CONTROL },
      });
    }

    const abs = resolvePath(id);
    if (!abs) {
      noArtCache.set(id, Date.now() + NO_ART_TTL_MS);
      return new Response(null, {
        status: 404,
        headers: { 'cache-control': 'public, max-age=300' },
      });
    }

    const art = await extractCover(abs);
    if (!art) {
      noArtCache.set(id, Date.now() + NO_ART_TTL_MS);
      return new Response(null, {
        status: 404,
        headers: { 'cache-control': 'public, max-age=300' },
      });
    }

    void cacheCover(coverCacheDir, id, art).catch((err) =>
      log.debug({ err, id }, 'cover cache write failed'),
    );
    return new Response(toBody(art.data), {
      headers: { 'content-type': art.contentType, 'cache-control': COVER_CACHE_CONTROL },
    });
  });

  return app;
}

/**
 * Serve a file from disk honouring an HTTP `Range` header (206 + Content-Range)
 * and advertising `Accept-Ranges` on the full 200 response. Shared by the
 * passthrough and transcode-cache paths so both are seekable. `contentTypeOverride`
 * is used for transcoded files, whose extension Bun doesn't always sniff (`.aac`).
 */
function serveFileWithRange(
  absPath: string,
  range: string | undefined,
  contentTypeOverride?: string,
): Response {
  const file = Bun.file(absPath);
  const size = file.size;
  const contentType = contentTypeOverride || file.type || 'application/octet-stream';

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      let start = m[1] ? Number(m[1]) : 0;
      let end = m[2] ? Number(m[2]) : size - 1;
      if (Number.isNaN(start)) start = 0;
      if (Number.isNaN(end) || end >= size) end = size - 1;
      if (start > end || start >= size) {
        return new Response(null, {
          status: 416,
          headers: { 'content-range': `bytes */${size}` },
        });
      }
      return new Response(file.slice(start, end + 1), {
        status: 206,
        headers: {
          'content-type': contentType,
          'content-length': String(end - start + 1),
          'content-range': `bytes ${start}-${end}/${size}`,
          'accept-ranges': 'bytes',
        },
      });
    }
  }

  return new Response(file, {
    status: 200,
    headers: {
      'content-type': contentType,
      'content-length': String(size),
      'accept-ranges': 'bytes',
    },
  });
}

interface CoverArt {
  data: Uint8Array;
  contentType: string;
}

// Bun accepts a Uint8Array as a Response body at runtime, but the TS lib's
// BodyInit union (under strict typed-array generics) rejects it — cast through.
function toBody(data: Uint8Array): BodyInit {
  return data as unknown as BodyInit;
}

function extFromContentType(ct: string): string {
  if (ct.includes('png')) return '.png';
  if (ct.includes('webp')) return '.webp';
  return '.jpg';
}

/** Fetch a remote canonical cover URL into memory. Null on any failure/non-image. */
async function fetchRemoteCover(url: string): Promise<CoverArt | null> {
  try {
    // why: a slow/dead canonical (Lidarr) URL must not hang the request — an
    // unbounded fetch ties up a browser connection slot and stalls sibling cover
    // and page-data requests behind it. On timeout we fall through to on-disk art.
    const res = await fetch(url, { signal: AbortSignal.timeout(REMOTE_COVER_TIMEOUT_MS) });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') ?? 'image/jpeg';
    if (!contentType.startsWith('image/')) return null;
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.length === 0) return null;
    return { data, contentType };
  } catch {
    return null;
  }
}

async function readCachedCover(dir: string, id: string): Promise<CoverArt | null> {
  for (const ext of COVER_EXTS) {
    const p = join(dir, id + ext);
    if (existsSync(p)) {
      try {
        const data = await readFile(p);
        const ct = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        return { data, contentType: ct };
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function cacheCover(dir: string, id: string, art: CoverArt): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, id + extFromContentType(art.contentType)), art.data);
}

/** Prefer a folder image (cover.jpg/folder.jpg…); fall back to embedded art. */
async function extractCover(absPath: string): Promise<CoverArt | null> {
  const folder = await folderCover(dirname(absPath));
  if (folder) return folder;
  try {
    const mm = await getMusicMetadata();
    if (!mm) return null;
    const meta = await mm.parseFile(absPath, { duration: false, skipCovers: false });
    const pic = meta.common.picture?.[0];
    if (pic) {
      return { data: new Uint8Array(pic.data), contentType: pic.format || 'image/jpeg' };
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function folderCover(dir: string): Promise<CoverArt | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const lower = new Map(entries.map((e) => [e.toLowerCase(), e]));
  for (const base of COVER_FILE_NAMES) {
    for (const ext of COVER_EXTS) {
      const match = lower.get(base + ext);
      if (match) {
        try {
          const data = await readFile(join(dir, match));
          const ct = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
          return { data, contentType: ct };
        } catch {
          /* try next */
        }
      }
    }
  }
  return null;
}
