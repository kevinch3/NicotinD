import { Hono } from 'hono';
import { join, resolve, dirname, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { getStreamingSettings } from '../services/streaming-settings.js';
import { ffmpegAvailable, transcodeFile } from '../services/transcode.js';
import { getMusicMetadata } from '../services/music-metadata-loader.js';
import { resolveArtwork, canonicalCacheKey } from '../services/artwork-store.js';

const log = createLogger('streaming');

const COVER_FILE_NAMES = ['cover', 'folder', 'front', 'album', 'albumart'];
const COVER_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];

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

  /** Resolve a library id (song id, or album id) to an absolute, in-root path. */
  function resolvePath(id: string): string | null {
    let row = db
      .query<{ path: string }, [string]>('SELECT path FROM library_songs WHERE id = ?')
      .get(id);
    if (!row) {
      // Album/artist cover ids point at a representative song's id; but fall back
      // to "first song of this album/artist id" in case the cover id is the group id.
      row = db
        .query<{ path: string }, [string, string]>(
          'SELECT path FROM library_songs WHERE album_id = ? OR artist_id = ? LIMIT 1',
        )
        .get(id, id);
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

    if (wantsTranscode) {
      const format =
        reqFormat && reqFormat !== 'raw' && reqFormat !== 'original'
          ? (reqFormat as 'mp3' | 'opus' | 'aac')
          : settings.format;
      const kbps = reqBitRate && reqBitRate > 0 ? reqBitRate : settings.maxBitRate;
      try {
        const { body, contentType } = transcodeFile(abs, format, kbps);
        return new Response(body, { status: 200, headers: { 'content-type': contentType } });
      } catch (err) {
        log.error({ err, abs }, 'transcode failed; falling back to original');
        // fall through to passthrough
      }
    }

    // Passthrough with HTTP range support.
    const file = Bun.file(abs);
    const size = file.size;
    const contentType = file.type || 'application/octet-stream';
    const range = c.req.header('range');

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
  });

  app.get('/cover/:id', async (c) => {
    const id = c.req.param('id');

    // 1. Canonical (Lidarr/MusicBrainz) artwork takes precedence so the app
    //    matches the hunt tool, and so artists get real poster images. Cached
    //    under a `c_<key>` namespace, shared across an album's songs.
    const canonical = resolveArtwork(db, id);
    if (canonical) {
      const cacheKey = canonicalCacheKey(canonical.key);
      const cached = await readCachedCover(coverCacheDir, cacheKey);
      if (cached) {
        return new Response(toBody(cached.data), {
          headers: { 'content-type': cached.contentType },
        });
      }
      const remote = await fetchRemoteCover(canonical.url);
      if (remote) {
        void cacheCover(coverCacheDir, cacheKey, remote).catch((err) =>
          log.debug({ err, id }, 'canonical cover cache write failed'),
        );
        return new Response(toBody(remote.data), {
          headers: { 'content-type': remote.contentType },
        });
      }
      // Remote fetch failed (offline / dead URL) — fall through to on-disk art.
    }

    // 2. On-disk art (folder image, then embedded tag).
    const cached = await readCachedCover(coverCacheDir, id);
    if (cached) {
      return new Response(toBody(cached.data), { headers: { 'content-type': cached.contentType } });
    }

    const abs = resolvePath(id);
    if (!abs) return c.body(null, 404);

    const art = await extractCover(abs);
    if (!art) return c.body(null, 404);

    void cacheCover(coverCacheDir, id, art).catch((err) =>
      log.debug({ err, id }, 'cover cache write failed'),
    );
    return new Response(toBody(art.data), { headers: { 'content-type': art.contentType } });
  });

  return app;
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
    const res = await fetch(url);
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
