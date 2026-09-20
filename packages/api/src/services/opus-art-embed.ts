import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';
import { findFolderCoverName } from './cover-sources.js';
import { folderArtBelongsToAlbum } from './album-folder.js';
import { attachPictureToOpus, preparePicture } from './opus-artwork.js';

const log = createLogger('opus-art-embed');

/**
 * Largest cover we will download before handing it to `preparePicture`.
 *
 * The cap that matters is `MAX_EMBEDDED_PICTURE_BYTES`, and `preparePicture`
 * re-compresses anything over it — but it has to have the bytes in hand first,
 * and an unbounded download from a URL we did not choose is how one bad row
 * stalls a whole pass.
 */
const MAX_FETCH_BYTES = 12 * 1024 * 1024;

/** Per-request ceiling on the artwork fetch. */
const FETCH_TIMEOUT_MS = 15_000;

export interface EmbedArtResult {
  /** Albums this pass looked at — the denominator, fixed before any work. */
  albums: number;
  albumsEmbedded: number;
  tracksEmbedded: number;
  /** Albums with no usable cover anywhere. Embedding cannot help these. */
  noSource: number;
  /** Albums whose folder image was rejected as a shared bucket's (#978). */
  sharedBucket: number;
  /** Albums whose remote cover could not be fetched. */
  fetchFailed: number;
  /** Tracks the writer declined or threw on. */
  failed: number;
  errorSample: string | null;
  /** True when work may remain — cancelled, or the limit filled a full page. */
  stopped: boolean;
  /** Last visited album id; feed back as `afterId` to continue. */
  cursor: string | null;
}

export interface EmbedArtOptions {
  apply: boolean;
  /** Max albums to visit. Omitted/<=0 → unbounded. */
  limit?: number;
  /** Resume cursor: only consider album ids strictly greater than this. */
  afterId?: string | null;
  /**
   * Use only the on-disk folder image, never the remote `cover_url`. Measured
   * on prod, that is 509 of the 1,180 addressable albums — so this is the
   * cheap, offline two-fifths of the job, not the whole of it.
   */
  localOnly?: boolean;
  shouldStop?: () => boolean;
  onProgress?: (p: { total: number; visited: number; label: string }) => void;
  /** Test seam; defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
}

interface AlbumRow {
  id: string;
  name: string | null;
  /** Any one track of the album, for the folder-art question. */
  path: string;
  cover_url: string | null;
}

interface TrackRow {
  id: string;
  path: string;
}

/**
 * Write the album's cover into its own `.opus` files.
 *
 * **What this can and cannot fix.** The cover route already prefers a canonical
 * artwork row, then a folder image, then embedded art — so an album with either
 * of the first two already renders in the app, and embedding changes nothing a
 * user sees there. What it buys is **portability**: art that travels with the
 * file to any other player, and a library that is internally consistent rather
 * than dependent on a sibling `cover.jpg` surviving a move.
 *
 * It follows that an album with **no** cover source cannot be helped here at
 * all. That is worth stating because the obvious target looks like the wrong
 * one: `libraryHealth`'s `unrenderable` slice is *defined* as having no artwork
 * row, no embedded art and no usable folder image, so targeting it would
 * convert exactly zero albums. Those need artwork *acquisition*
 * (`backfillArtwork`, or the cover picker), not embedding.
 *
 * Measured on prod, 2026-09-20 — 7,774 Opus tracks, none carrying embedded art:
 *
 * | opus albums lacking embedded art | 1,736 |
 * | --- | --- |
 * | source = artwork row (remote URL) | 671 |
 * | source = folder image only | 509 |
 * | no source at all | 556 |
 *
 * **Opus only.** `attachPictureToOpus` muxes Ogg; an mp3 would need the ID3
 * writer instead, and the mp3s are 89.5% covered already.
 *
 * The cover is resolved and capped **once per album**, then attached to each
 * track — decoding it per track would pay the re-compress ladder over and over
 * on a 125-track compilation.
 */
export async function embedAlbumArt(
  db: Database,
  musicDir: string,
  opts: EmbedArtOptions,
): Promise<EmbedArtResult> {
  const result: EmbedArtResult = {
    albums: 0,
    albumsEmbedded: 0,
    tracksEmbedded: 0,
    noSource: 0,
    sharedBucket: 0,
    fetchFailed: 0,
    failed: 0,
    errorSample: null,
    stopped: false,
    cursor: null,
  };

  const limit = opts.limit != null && opts.limit > 0 ? opts.limit : -1; // SQLite: negative = no limit
  const afterId = opts.afterId ?? null;

  // `ORDER BY id` is load-bearing, the same reason `metadata-optimize` states:
  // without a stable order a bounded pass re-walks an arbitrary head forever.
  const albums = db
    .query<AlbumRow, [string | null, string | null, number]>(
      `SELECT a.id,
              a.name,
              MIN(s.path) AS path,
              (SELECT w.cover_url FROM library_artwork w
                WHERE w.id = a.id AND w.kind = 'album') AS cover_url
         FROM library_albums a
         JOIN library_songs s ON s.album_id = a.id
        WHERE a.hidden = 0
          AND s.suffix = 'opus'
          AND (s.has_embedded_art IS NULL OR s.has_embedded_art = 0)
          AND (? IS NULL OR a.id > ?)
        GROUP BY a.id
        ORDER BY a.id
        LIMIT ?`,
    )
    .all(afterId, afterId, limit);
  result.albums = albums.length;

  let visited = 0;
  for (const album of albums) {
    if (opts.shouldStop?.()) {
      result.stopped = true;
      break;
    }
    visited += 1;
    result.cursor = album.id;
    const label = album.name ?? album.id;
    const emit = () => opts.onProgress?.({ total: albums.length, visited, label });

    const scratch: string[] = [];
    try {
      const source = await resolveCover(db, musicDir, album, opts, result, scratch);
      if (!source) {
        emit();
        continue;
      }

      // Cap once for the whole album. `null` means even the softest quality
      // could not get under the reader's ceiling — an explicit do-not-embed.
      const fit = join(dirname(source), `.nicotind-art-fit-${album.id}.jpg`);
      scratch.push(fit);
      const prepared = preparePicture(source, fit);
      if (!prepared) {
        result.noSource += 1;
        emit();
        continue;
      }

      const tracks = db
        .query<TrackRow, [string]>(
          `SELECT id, path FROM library_songs
            WHERE album_id = ? AND suffix = 'opus'
              AND (has_embedded_art IS NULL OR has_embedded_art = 0)`,
        )
        .all(album.id);

      let wrote = 0;
      for (const track of tracks) {
        const abs = join(musicDir, track.path);
        if (!existsSync(abs)) {
          result.failed += 1;
          continue;
        }
        if (!opts.apply) {
          wrote += 1;
          continue;
        }
        if (!attachPictureToOpus(abs, prepared.path)) {
          result.failed += 1;
          result.errorSample ??= `could not attach cover to ${track.path}`;
          continue;
        }
        // Only the scanner writes this column, and its upsert COALESCEs — so a
        // rescan would keep the stale 0 and every later pass would redo this
        // album. Setting it here is what makes the work stick.
        db.run('UPDATE library_songs SET has_embedded_art = 1 WHERE id = ?', [track.id]);
        wrote += 1;
      }

      if (wrote > 0) {
        result.albumsEmbedded += 1;
        result.tracksEmbedded += wrote;
      }
    } catch (err) {
      log.warn({ err, albumId: album.id }, 'embedding album art failed; continuing');
      result.failed += 1;
      result.errorSample ??= err instanceof Error ? err.message : String(err);
    } finally {
      for (const p of scratch) {
        try {
          rmSync(p, { force: true });
        } catch {
          /* best effort */
        }
      }
    }
    emit();
  }
  if (limit > 0 && albums.length === limit) result.stopped = true;

  log.info({ ...result, apply: opts.apply }, 'opus art embed pass complete');
  return result;
}

/**
 * Where this album's cover comes from, in cost order: the folder image beside
 * the tracks first, then the artwork row's remote URL.
 *
 * Pushes any file it had to create onto `scratch` so the caller's `finally`
 * removes it. Returns `null` when the album has no usable source, having
 * already counted *why* on `result` — "no cover anywhere", "the folder image
 * belongs to a shared bucket" and "the fetch failed" need different fixes, so
 * collapsing them into one number would hide which.
 */
async function resolveCover(
  db: Database,
  musicDir: string,
  album: AlbumRow,
  opts: EmbedArtOptions,
  result: EmbedArtResult,
  scratch: string[],
): Promise<string | null> {
  // A folder image only counts as THIS album's art when the directory is its
  // own and not a shared singles bucket — the same question the cover route
  // asks before serving it. #978 is one stray cover.jpg that had become the
  // cover of 1,229 unrelated albums; baking that into the files would make it
  // permanent rather than merely wrong.
  const dir = dirname(join(musicDir, album.path));
  if (folderArtBelongsToAlbum(db, album.path)) {
    const name = findFolderCoverName(dir);
    if (name) return join(dir, name);
  } else if (findFolderCoverName(dir)) {
    result.sharedBucket += 1;
  }

  if (opts.localOnly || !album.cover_url) {
    result.noSource += 1;
    return null;
  }

  const fetched = await downloadCover(album.cover_url, album.id, dir, opts.fetchFn);
  if (!fetched) {
    result.fetchFailed += 1;
    return null;
  }
  scratch.push(fetched);
  return fetched;
}

/**
 * Pull a remote cover to a scratch file beside the album, or `null`.
 *
 * `library_artwork` stores a **URL**, not bytes (3,680 of 3,690 rows on prod
 * are `http(s)`), and the on-disk cover cache is populated lazily by the
 * streaming route — it does not exist at all on a box that has not served those
 * covers. So this pass has to fetch, which is why it is skippable.
 *
 * Never throws: a cover is an enhancement, and one unreachable host must not
 * end a pass over hundreds of albums.
 */
async function downloadCover(
  url: string,
  albumId: string,
  dir: string,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (!type.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    // Bounded after the fact as well as before: `content-length` is a claim,
    // and a chunked response makes none at all.
    if (buf.length === 0 || buf.length > MAX_FETCH_BYTES) return null;
    const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
    const out = join(dir, `.nicotind-art-src-${albumId}.${ext}`);
    writeFileSync(out, buf);
    return out;
  } catch (err) {
    log.debug({ err, url }, 'cover fetch failed');
    return null;
  }
}
