import type { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { setArtwork, deleteArtwork, purgeDiskArtCache } from './artwork-store.js';
import {
  extractEmbeddedPicture,
  replaceFolderCover,
  type EmbeddedPicture,
} from './cover-sources.js';
import { folderArtBelongsToAlbum } from './album-folder.js';
import { expandDir, resolveSongPath, isUnderMusicDir } from './song-path.js';
import { clearAlbumCoverNegativeCache } from './cover-negative-cache.js';
import { bumpCoverRev } from './cover-rev.js';
import { resizeCover } from './cover-thumbnail.js';

/**
 * Album-cover mutation shared by `POST /api/library/albums/:id/cover` and the
 * MCP `set_album_cover` tool — fifth instance of the shared-mutation shape
 * (library-deletion → artist-identity-mutate → song-genre-mutate →
 * song-metadata-mutate). Result is a discriminated union; auditing stays
 * caller-side so each surface names its own actor.
 *
 * Three modes (upload, then coverUrl, then songId when several are sent):
 *  - `upload`   — an uploaded image (`PUT /albums/:id/cover`), standardized to a
 *    square WebP and written as the album's folder cover.
 *  - `coverUrl` — store the canonical `library_artwork` URL (survives rescans).
 *  - `songId`   — materialize that track's embedded picture as the album's
 *    folder cover and delete the canonical row, so the file art wins.
 *
 * Every mode that changes the art bumps the album's `cover_rev` (cover-rev.ts),
 * which evicts the negative cache and emits `artwork.changed` — so the upload,
 * the picker and the MCP tool all announce themselves the same way (#1666).
 */

export interface AlbumCoverMutateDeps {
  musicDir?: string;
  coverCacheDir?: string;
  /** Test seam — defaults to the real embedded-picture reader. */
  extractPicture?: (absPath: string) => Promise<EmbeddedPicture | null>;
}

export interface AlbumCoverBody {
  coverUrl?: string;
  songId?: string;
  /** Raw uploaded bytes; the route validates type and size before passing them. */
  upload?: { data: Uint8Array; contentType: string };
}

export type AlbumCoverMutateResult =
  | { ok: true; mode: 'canonical-url' | 'folder-cover' | 'upload'; coverRev: number | null }
  | { ok: false; error: string; status: 400 | 404 | 503 };

export async function applyAlbumCover(
  db: Database,
  deps: AlbumCoverMutateDeps,
  albumId: string,
  body: AlbumCoverBody,
): Promise<AlbumCoverMutateResult> {
  const album = db
    .query<{ id: string }, [string]>('SELECT id FROM library_albums WHERE id = ?')
    .get(albumId);
  if (!album) return { ok: false, error: 'Album not found', status: 404 };

  if (body.upload) return applyUpload(db, deps, albumId, body.upload);

  const coverUrl = body.coverUrl?.trim();
  if (coverUrl) {
    setArtwork(db, albumId, 'album', coverUrl, deps.coverCacheDir); // bumps on a new URL
    clearAlbumCoverNegativeCache(db, albumId); // a re-apply of the same URL retries a 404
    return { ok: true, mode: 'canonical-url', coverRev: currentCoverRev(db, albumId) };
  }

  const songId = body.songId?.trim();
  if (songId) {
    if (!deps.musicDir) {
      return { ok: false, error: 'Music directory not configured', status: 503 };
    }
    const song = db
      .query<{ path: string }, [string, string]>(
        'SELECT path FROM library_songs WHERE id = ? AND album_id = ?',
      )
      .get(songId, albumId);
    if (!song) return { ok: false, error: 'Song not in this album', status: 404 };
    const md = expandDir(deps.musicDir);
    const abs = resolveSongPath(md, song.path);
    if (!isUnderMusicDir(md, abs) || !existsSync(abs)) {
      return { ok: false, error: 'Song file not found', status: 404 };
    }
    const pic = await (deps.extractPicture ?? extractEmbeddedPicture)(abs);
    if (!pic) return { ok: false, error: 'That track has no embedded artwork', status: 400 };
    const coverRev = commitFolderCover(db, deps, albumId, abs, song.path, pic);
    return { ok: true, mode: 'folder-cover', coverRev };
  }

  return { ok: false, error: 'Provide coverUrl or songId', status: 400 };
}

async function applyUpload(
  db: Database,
  deps: AlbumCoverMutateDeps,
  albumId: string,
  upload: { data: Uint8Array; contentType: string },
): Promise<AlbumCoverMutateResult> {
  if (!deps.musicDir) return { ok: false, error: 'Music directory not configured', status: 503 };
  const md = expandDir(deps.musicDir);
  const song = db
    .query<{ path: string }, [string]>(
      `SELECT path FROM library_songs WHERE album_id = ?
       ORDER BY COALESCE(disc, 1), COALESCE(track, 999999), path LIMIT 1`,
    )
    .get(albumId);
  const abs = song ? resolveSongPath(md, song.path) : null;
  if (!song || !abs || !isUnderMusicDir(md, abs) || !existsSync(abs)) {
    return { ok: false, error: 'Album has no track files to store a cover next to', status: 404 };
  }
  let resized: EmbeddedPicture;
  try {
    resized = await resizeCover(upload.data, 1200);
  } catch {
    return { ok: false, error: 'Could not read that image', status: 400 };
  }
  const coverRev = commitFolderCover(db, deps, albumId, abs, song.path, resized);
  return { ok: true, mode: 'upload', coverRev };
}

/** Write `pic` as the album's folder cover; the canonical row goes so the file art wins. */
function commitFolderCover(
  db: Database,
  deps: AlbumCoverMutateDeps,
  albumId: string,
  absSongPath: string,
  relSongPath: string,
  pic: EmbeddedPicture,
): number | null {
  replaceFolderCover(dirname(absSongPath), pic, folderArtBelongsToAlbum(db, relSongPath));
  if (deps.coverCacheDir) purgeDiskArtCache(deps.coverCacheDir, albumId);
  // deleteArtwork bumps when it removed a canonical row; the folder bytes changed
  // either way, so bump here only when it did not — one change, one bump.
  if (!deleteArtwork(db, albumId, deps.coverCacheDir)) bumpCoverRev(db, 'album', albumId);
  return currentCoverRev(db, albumId);
}

function currentCoverRev(db: Database, albumId: string): number | null {
  return (
    db
      .query<{ cover_rev: number }, [string]>('SELECT cover_rev FROM library_albums WHERE id = ?')
      .get(albumId)?.cover_rev ?? null
  );
}
