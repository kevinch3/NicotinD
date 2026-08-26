import type { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { setArtwork, deleteArtwork, purgeDiskArtCache } from './artwork-store.js';
import { extractEmbeddedPicture, writeFolderCover, type EmbeddedPicture } from './cover-sources.js';
import { expandDir, resolveSongPath, isUnderMusicDir } from './song-path.js';
import { clearCoverNegativeCache } from '../routes/streaming.js';

/**
 * Album-cover mutation shared by `POST /api/library/albums/:id/cover` and the
 * MCP `set_album_cover` tool — fifth instance of the shared-mutation shape
 * (library-deletion → artist-identity-mutate → song-genre-mutate →
 * song-metadata-mutate). Result is a discriminated union; auditing stays
 * caller-side so each surface names its own actor.
 *
 * Two modes (coverUrl wins when both are sent, matching the original route):
 *  - `coverUrl` — store the canonical `library_artwork` URL (survives rescans).
 *  - `songId`   — materialize that track's embedded picture as the album's
 *    folder cover and delete the canonical row, so the file art wins.
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
}

export type AlbumCoverMutateResult =
  | { ok: true; mode: 'canonical-url' | 'folder-cover' }
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

  const coverUrl = body.coverUrl?.trim();
  if (coverUrl) {
    setArtwork(db, albumId, 'album', coverUrl, deps.coverCacheDir);
    clearCoverNegativeCache(albumId); // in case this id was 404-cached as artless
    return { ok: true, mode: 'canonical-url' };
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
    writeFolderCover(dirname(abs), pic);
    deleteArtwork(db, albumId, deps.coverCacheDir); // clear canonical → folder art wins
    if (deps.coverCacheDir) purgeDiskArtCache(deps.coverCacheDir, albumId);
    clearCoverNegativeCache(albumId);
    return { ok: true, mode: 'folder-cover' };
  }

  return { ok: false, error: 'Provide coverUrl or songId', status: 400 };
}
