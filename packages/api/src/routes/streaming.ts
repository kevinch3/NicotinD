import { Hono } from 'hono';
import { join, resolve, dirname, sep } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { getStreamingSettings } from '../services/streaming-settings.js';
import { ffmpegAvailable, transcodeContentType } from '../services/transcode.js';
import {
  type TranscodeVariant,
  getTranscodedFile,
  pinTranscodeCacheFile,
  schedulePinRelease,
} from '../services/transcode-cache.js';
import { extractEmbeddedPicture } from '../services/cover-sources.js';
import { resolveArtwork, canonicalCacheKey } from '../services/artwork-store.js';
import { bucketCoverSize, resizeCover } from '../services/cover-thumbnail.js';
import { readArtistImageOverride } from '../services/artist-image-override.js';
import { remoteCoverCacheKey, resolveRemoteCoverUrl } from '../services/remote-cover.js';
import { isKnownUntranscodable, rememberTranscodeFailure } from '../services/transcode-failures.js';
import { getWaveform, type PcmDecoder } from '../services/waveform-store.js';

const log = createLogger('streaming');

// Song id → expiry for waveform decodes that failed (corrupt file). Without it
// a doomed full-file ffmpeg pass would re-run on every Now Playing open — the
// #317 shape. Content-addressed enough: a repaired re-download changes the id's
// size/mtime and the TTL is short, so no explicit eviction is wired.
const noWaveformCache = new Map<string, number>();
const NO_WAVEFORM_TTL_MS = 10 * 60 * 1_000;
const WAVEFORM_CACHE_CONTROL = 'public, max-age=86400';

/** Test-only: forget remembered waveform decode failures. */
export function _resetWaveformNegativeCacheForTests(): void {
  noWaveformCache.clear();
}

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
export function streamingRoutes(
  musicDir: string,
  db: Database,
  dataDir: string,
  /** Base URL of the configured Lidarr, so relative `/MediaCover/…` covers resolve. */
  lidarrBaseUrl?: string | null,
  opts: {
    /** Test seam: replaces the ffmpeg PCM decoder behind `/peaks/:id`. */
    waveformDecoder?: PcmDecoder;
    /** ML vocal separation (issue #603): "is a stem FLAC ready?" — sync, never waits. */
    stems?: { readyStemPath(absPath: string): string | null } | null;
  } = {},
) {
  const app = new Hono<AuthEnv>();
  const musicRoot = resolve(musicDir);
  const coverCacheDir = join(dataDir, 'cover-cache');
  const transcodeCacheDir = join(dataDir, 'transcode-cache');
  const waveformCacheDir = join(dataDir, 'waveform-cache');

  /** Resolve a library id (song id, or album id) to an absolute, in-root path. */
  function resolvePath(id: string): string | null {
    let row = db
      .query<{ path: string }, [string]>('SELECT path FROM library_songs WHERE id = ?')
      .get(id);
    if (!row) {
      // Album cover ids point at a representative song. Pick the album's FIRST
      // track (lowest disc/track) deterministically rather than an arbitrary row:
      // track 1 lives in the canonical album folder, so its folder image is the
      // album's real cover. why: an unordered `LIMIT 1` could land on a
      // mislabeled/wrong-source file in the same folder, giving the album the
      // wrong thumbnail even while individual tracks show correct embedded art.
      // (Foreign rips are already excluded from library_songs by the scanner's
      // track selection, which further narrows this to real album tracks.)
      //
      // why no `artist_id` fallback: an artist id (a distinct sha1 namespace,
      // never matched by `album_id`) deliberately resolves to null here, so the
      // cover route returns 404 and the UI shows the neutral initial-on-gradient
      // tile. A representative track's album art is a *wrong* face for the artist
      // (often an old/misleading release) — worse than the clean placeholder. Real
      // artist portraits come from canonical artwork (Lidarr/Spotify) or a manual
      // override, both resolved before this fallback.
      row = db
        .query<{ path: string }, [string]>(
          `SELECT path FROM library_songs WHERE album_id = ?
             ORDER BY COALESCE(disc, 1), COALESCE(track, 999999), path LIMIT 1`,
        )
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
    const range = c.req.header('range');
    const ifRange = c.req.header('if-range');
    // Karaoke vocal mute (?vocals=off). Filtering can only happen while re-encoding,
    // so it forces the transcode path even when transcoding is otherwise off — the
    // one thing that must override `transcodeEnabled`. Still needs ffmpeg; without
    // it we degrade to an unfiltered passthrough rather than 500.
    const vocalRemoval = c.req.query('vocals') === 'off';

    const wantsTranscode =
      ffmpegAvailable() &&
      (vocalRemoval ||
        (settings.transcodeEnabled &&
          (settings.forceTranscode || (reqFormat && reqFormat !== 'raw') || reqBitRate != null)));

    if (wantsTranscode) {
      const format =
        reqFormat && reqFormat !== 'raw' && reqFormat !== 'original'
          ? (reqFormat as 'mp3' | 'opus' | 'aac')
          : settings.format;
      const kbps = reqBitRate && reqBitRate > 0 ? reqBitRate : settings.maxBitRate;

      // Which rendition(s) to try, best first. For a vocal mute (issue #603)
      // that is the ML stem when its FLAC is on disk, then the basic
      // center-cancel filter — decided here, server-side, because the client
      // cannot know whether the stem survived a prune or the sidecar just went
      // down, and an <audio> element cannot act on a 409. Readiness is a stat;
      // this route never waits on the GPU. Each attempt carries its own
      // negative-cache identity: a bad stem encode is remembered against the
      // STEM file, never against the original (issue #317's cache is keyed on
      // whatever path it is given).
      const stemPath = vocalRemoval ? (opts.stems?.readyStemPath(abs) ?? null) : null;
      const attempts: Array<{ variant: TranscodeVariant; inputPath?: string; identity: string }> =
        [];
      if (stemPath) attempts.push({ variant: 'stem', inputPath: stemPath, identity: stemPath });
      attempts.push({ variant: vocalRemoval ? 'novox' : 'plain', identity: abs });

      for (const attempt of attempts) {
        // A file that already produced an unusable transcode is served straight
        // from the next rendition (ultimately the original) — re-running the
        // doomed ffmpeg pass on every play was the whole of issue #317. The key
        // includes size+mtime, so a repaired re-download transcodes normally
        // again with no manual eviction.
        if (isKnownUntranscodable(attempt.identity)) {
          log.debug({ abs, variant: attempt.variant }, 'skipping transcode: known-unusable output');
          continue;
        }
        try {
          // Transcode to a cached file (once) and serve THAT with range support, so
          // transcoded streams are seekable. A sequential ffmpeg pipe (status 200,
          // no content-length / accept-ranges) can't be seeked, which is why far
          // seeks did nothing on iOS/Firefox when transcoding was on.
          const cached = await getTranscodedFile(transcodeCacheDir, abs, format, kbps, {
            variant: attempt.variant,
            inputPath: attempt.inputPath,
          });
          // Pin the cache file so a concurrent prune can't unlink it before Bun's
          // response machinery has opened it. The body must stay a plain Blob:
          // the previous implementation wrapped it in a ReadableStream to release
          // the pin at stream end, and Bun serializes an unknown-length stream as
          // `Transfer-Encoding: chunked`, silently dropping Content-Length — a
          // chunked 206 is the exact response shape Firefox's and iOS Safari's
          // media loaders stall on forever (the same failure nativeAppCors()
          // documents), so every transcoded stream "loaded metadata but never
          // finished loading". Once Bun has the file open, a POSIX unlink no
          // longer affects the in-flight send, so the pin only needs to outlive
          // the open — released on a grace timer, not at stream end.
          schedulePinRelease(pinTranscodeCacheFile(cached));
          const res = serveFileWithRange(cached, range, transcodeContentType(format), ifRange);
          // Tells tests and devtools which mute was served; the player learns the
          // mode from the stem status endpoint, not from here.
          if (vocalRemoval) {
            res.headers.set('x-nicotind-vocals', attempt.variant === 'stem' ? 'ml' : 'basic');
          }
          return res;
        } catch (err) {
          // Remember the verdict so the next play skips straight to the fallback.
          rememberTranscodeFailure(attempt.identity, err);
          log.error({ err, abs, variant: attempt.variant }, 'transcode failed; falling back');
        }
      }
    }

    // Passthrough with HTTP range support.
    return serveFileWithRange(abs, range, undefined, ifRange);
  });

  /** Build a cover Response, downsizing to the requested `size` bucket when one
   *  was given. The resized variant is cached under `<baseKey>@<size>` so repeat
   *  thumbnail hits read one small file; a resize failure falls back to the full
   *  image so a cover is never lost to a bad encode. */
  async function respondCover(
    baseKey: string,
    art: CoverArt,
    size: number | null,
  ): Promise<Response> {
    if (size == null) return coverResponse(art);
    const sizedKey = `${baseKey}@${size}`;
    const sizedCached = await readCachedCover(coverCacheDir, sizedKey);
    if (sizedCached) return coverResponse(sizedCached);
    try {
      const resized = await resizeCover(art.data, size);
      void cacheCover(coverCacheDir, sizedKey, resized).catch((err) =>
        log.debug({ err, baseKey, size }, 'sized cover cache write failed'),
      );
      return coverResponse(resized);
    } catch (err) {
      log.debug({ err, baseKey, size }, 'cover resize failed; serving original');
      return coverResponse(art);
    }
  }

  /**
   * Proxy + downscale a catalog (Lidarr/MusicBrainz) cover. Catalog cards have
   * no library id to hang art off, so they carry an upstream URL; serving it to
   * the browser meant a 1200 px third-party JPEG per ~150 px tile (issue #263).
   * Here it becomes a sized WebP from our own disk cache instead.
   *
   * Registered before `/cover/:id` so the literal `remote` segment wins over the
   * id parameter.
   */
  app.get('/cover/remote', async (c) => {
    const size = bucketCoverSize(c.req.query('size'));
    const target = resolveRemoteCoverUrl(c.req.query('u'), lidarrBaseUrl);
    // Rejected by the allowlist (or unparseable) — never fetch it.
    if (!target) return new Response(null, { status: 400 });

    const key = remoteCoverCacheKey(target);
    if ((noArtCache.get(key) ?? 0) > Date.now()) {
      return new Response(null, {
        status: 404,
        headers: { 'cache-control': 'public, max-age=300' },
      });
    }

    const cached = await readCachedCover(coverCacheDir, key);
    if (cached) return respondCover(key, cached, size);

    const remote = await fetchRemoteCover(target);
    if (!remote) {
      // A confident miss is cached briefly so a dead upstream isn't re-fetched
      // on every tile render; 404 is a state <app-cover-art> renders as its
      // placeholder rather than hanging on a never-resolving <img>.
      noArtCache.set(key, Date.now() + NO_ART_TTL_MS);
      return new Response(null, {
        status: 404,
        headers: { 'cache-control': 'public, max-age=300' },
      });
    }
    void cacheCover(coverCacheDir, key, remote).catch((err) =>
      log.debug({ err, key }, 'remote cover cache write failed'),
    );
    return respondCover(key, remote, size);
  });

  app.get('/cover/:id', async (c) => {
    const id = c.req.param('id');
    // Snap the requested dimension to a cache bucket (null → serve original).
    const size = bucketCoverSize(c.req.query('size'));

    // `?embedded=1` serves ONLY the file's embedded picture (skipping canonical
    // and folder art) — used by the Fix-metadata cover picker so the user can
    // see/choose the artwork baked into a specific track. Cached under a
    // `~emb`-suffixed key so it never collides with the normal resolution chain.
    if (c.req.query('embedded') === '1') {
      const embKey = `${id}~emb`;
      if ((noArtCache.get(embKey) ?? 0) > Date.now()) {
        return new Response(null, {
          status: 404,
          headers: { 'cache-control': 'public, max-age=300' },
        });
      }
      const embCached = await readCachedCover(coverCacheDir, embKey);
      if (embCached) return respondCover(embKey, embCached, size);
      const abs = resolvePath(id);
      const pic = abs ? await extractEmbeddedPicture(abs) : null;
      if (!pic) {
        noArtCache.set(embKey, Date.now() + NO_ART_TTL_MS);
        return new Response(null, {
          status: 404,
          headers: { 'cache-control': 'public, max-age=300' },
        });
      }
      void cacheCover(coverCacheDir, embKey, pic).catch((err) =>
        log.debug({ err, id }, 'embedded cover cache write failed'),
      );
      return respondCover(embKey, pic, size);
    }

    // 0. Manual artist-image override (user upload / album-cover pick) wins over
    //    everything. Served from a persistent dir keyed on the artist id, under the
    //    un-prefixed cache namespace — which, for an artist id, only the override
    //    can occupy (artist ids have no on-disk-art fallback, see resolvePath).
    const override = await readArtistImageOverride(dataDir, id);
    if (override) return respondCover(id, override, size);

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
      if (cached) return respondCover(cacheKey, cached, size);
      const remote = await fetchRemoteCover(canonical.url);
      if (remote) {
        void cacheCover(coverCacheDir, cacheKey, remote).catch((err) =>
          log.debug({ err, id }, 'canonical cover cache write failed'),
        );
        return respondCover(cacheKey, remote, size);
      }
      // Remote fetch failed (offline / dead URL) — fall through to on-disk art.
    }

    // 2. On-disk art (folder image, then embedded tag).
    const cached = await readCachedCover(coverCacheDir, id);
    if (cached) return respondCover(id, cached, size);

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
    return respondCover(id, art, size);
  });

  /**
   * Waveform artifact for the Now Playing strip + karaoke VFX (issue #643):
   * min/max peaks + a six-band energy timeline, generated on demand from one
   * ffmpeg decode (the transcode-in-handler precedent) and cached on disk,
   * content-addressed. Songs only — an album id has no single waveform. A
   * 404 means "no waveform" and the UI keeps the plain seek bar; a decode
   * failure is remembered for NO_WAVEFORM_TTL_MS so it isn't retried per open.
   */
  app.get('/peaks/:id', async (c) => {
    const id = c.req.param('id');
    const expiry = noWaveformCache.get(id);
    if (expiry !== undefined) {
      if (expiry > Date.now()) return c.body(null, 404);
      noWaveformCache.delete(id);
    }
    const row = db
      .query<{ path: string }, [string]>('SELECT path FROM library_songs WHERE id = ?')
      .get(id);
    if (!row) return c.body(null, 404);
    const abs = resolve(join(musicRoot, row.path));
    if ((abs !== musicRoot && !abs.startsWith(musicRoot + sep)) || !existsSync(abs)) {
      return c.body(null, 404);
    }
    try {
      const data = await getWaveform(waveformCacheDir, abs, { decoder: opts.waveformDecoder });
      return c.json(data, 200, { 'cache-control': WAVEFORM_CACHE_CONTROL });
    } catch (err) {
      log.warn({ err, abs }, 'waveform decode failed');
      noWaveformCache.set(id, Date.now() + NO_WAVEFORM_TTL_MS);
      return c.body(null, 404);
    }
  });

  return app;
}

/**
 * Serve a file from disk honouring an HTTP `Range` header (206 + Content-Range)
 * and advertising `Accept-Ranges` on the full 200 response. Shared by the
 * passthrough and transcode-cache paths so both are seekable. `contentTypeOverride`
 * is used for transcoded files, whose extension Bun doesn't always sniff (`.aac`).
 *
 * Every 200/206 carries a strong validator (`ETag` from size+mtime, plus
 * `Last-Modified`), and a `Range` accompanied by a non-matching `If-Range` is
 * ignored in favour of the full current file (RFC 9110 §13.1.5). Without a
 * validator the browser's media loader has no way to notice the resource
 * changing between its range requests — a library file rewritten (tag write,
 * in-place transcode) mid-playback got its old and new bytes spliced into one
 * buffer, a corrupt stream that decodes for the first buffered seconds and
 * then dies with no error (the "plays 3-4 s then silently stalls" HAR capture:
 * two consecutive 206es for one track reported different total sizes).
 *
 * The body is always the `Bun.file` Blob (or a slice of it), never a wrapping
 * ReadableStream: Bun serializes an unknown-length stream as
 * `Transfer-Encoding: chunked` and drops the Content-Length header the route
 * set, and a chunked 206 stalls Firefox's and iOS Safari's media loaders
 * forever (see `nativeAppCors()` for the first sighting of this failure class).
 * Exported for the wire-level contract tests in streaming.test.ts.
 */
export function serveFileWithRange(
  absPath: string,
  range: string | undefined,
  contentTypeOverride?: string,
  ifRange?: string,
): Response {
  const file = Bun.file(absPath);
  const size = file.size;
  const contentType = contentTypeOverride || file.type || 'application/octet-stream';

  // Strong validator: byte-identity holds for an unchanged size+mtime pair
  // (mtimeMs sub-second precision; the transcode cache already keys source
  // size+mtime for the same reason). A vanished file skips the headers — the
  // body read is about to fail anyway.
  let mtimeMs: number | null = null;
  try {
    mtimeMs = statSync(absPath).mtimeMs;
  } catch {
    /* raced deletion */
  }
  const etag =
    mtimeMs === null ? null : `"${size.toString(16)}-${Math.round(mtimeMs).toString(16)}"`;
  const lastModified = mtimeMs === null ? null : new Date(mtimeMs).toUTCString();

  // If-Range: honour the Range only when the representation is provably the
  // one the client holds — entity-tag form needs a strong match against the
  // current ETag (a weak `W/` tag never matches, per the RFC); date form
  // needs second-exact equality with our Last-Modified. Anything else
  // (changed file, unparseable value, no local validator) falls through to
  // the full 200, which media loaders handle as a clean reload.
  if (range && ifRange !== undefined) {
    const val = ifRange.trim();
    let matches = false;
    if (val.startsWith('"')) {
      matches = etag !== null && val === etag;
    } else if (!val.startsWith('W/') && mtimeMs !== null) {
      const parsed = Date.parse(val);
      matches = Number.isFinite(parsed) && Math.floor(parsed / 1000) === Math.floor(mtimeMs / 1000);
    }
    if (!matches) range = undefined;
  }

  const buildResponse = (
    body: BodyInit,
    status: number,
    extraHeaders: Record<string, string> = {},
  ): Response =>
    new Response(body, {
      status,
      headers: {
        'content-type': contentType,
        ...extraHeaders,
        ...(etag !== null && lastModified !== null ? { etag, 'last-modified': lastModified } : {}),
        'accept-ranges': 'bytes',
      },
    });

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    // `bytes=-` (both halves empty) is malformed — RFC 9110 lets the server
    // ignore an invalid Range and fall through to the full 200 below.
    if (m && (m[1] || m[2])) {
      let start: number;
      let end: number;
      if (!m[1]) {
        // Suffix range (`bytes=-N`): the LAST N bytes of the file. iOS
        // Safari's media loader (CoreMedia) uses this form to probe container
        // tail metadata. This branch used to fall into the generic parse as
        // start=0/end=N — the WRONG bytes under a Content-Range that didn't
        // match the request — so the parse produced garbage and Safari
        // re-requested forever: track metadata loaded, the song never finished
        // loading (the iPhone-PWA report). A zero-length suffix is
        // unsatisfiable per RFC 9110 §14.1.2.
        const suffixLen = Number(m[2]);
        if (suffixLen === 0) {
          return new Response(null, {
            status: 416,
            headers: { 'content-range': `bytes */${size}` },
          });
        }
        start = Math.max(0, size - suffixLen);
        end = size - 1;
      } else {
        start = Number(m[1]);
        end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      }
      if (start > end || start >= size) {
        return new Response(null, {
          status: 416,
          headers: { 'content-range': `bytes */${size}` },
        });
      }
      return buildResponse(file.slice(start, end + 1), 206, {
        'content-length': String(end - start + 1),
        'content-range': `bytes ${start}-${end}/${size}`,
      });
    }
  }

  return buildResponse(file, 200, {
    'content-length': String(size),
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

/** 200 response for resolved cover bytes, with the shared long-lived cache header. */
function coverResponse(art: CoverArt): Response {
  return new Response(toBody(art.data), {
    headers: { 'content-type': art.contentType, 'cache-control': COVER_CACHE_CONTROL },
  });
}

function extFromContentType(ct: string): string {
  if (ct.includes('png')) return '.png';
  if (ct.includes('webp')) return '.webp';
  return '.jpg';
}

/** Fetch a remote canonical cover URL into memory. Null on any failure/non-image. */
export async function fetchRemoteCover(url: string): Promise<CoverArt | null> {
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
export async function extractCover(absPath: string): Promise<CoverArt | null> {
  const folder = await folderCover(dirname(absPath));
  if (folder) return folder;
  return extractEmbeddedPicture(absPath);
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
