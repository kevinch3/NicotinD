/**
 * Song/album file + row deletion — extracted out of routes/library.ts (issue
 * #232) so the MCP agent surface can call the same deletion path an HTTP
 * request uses, instead of a third `rmSync` copy living in routes/mcp.ts.
 *
 * `db`, `musicDir` and the `ShareRescanScheduler` instance are explicit
 * params rather than closures, mirroring services/agent-tokens.ts — the two
 * callers (the HTTP routes and the MCP tools) each own their own
 * musicDir/scheduler wiring and shouldn't share module state.
 */
import type { Database } from 'bun:sqlite';
import { basename, dirname, join, normalize, relative } from 'node:path';
import { existsSync, readdirSync, rmdirSync, rmSync, unlinkSync } from 'node:fs';
import { createLogger } from '@nicotind/core';
import { getDatabase } from '../db.js';
import { pruneOrphanArtist, pruneOrphanAlbum } from './library-aggregates.js';
import type { ShareRescanScheduler } from './share-rescan-scheduler.js';
import { expandDir, resolveSongPath, isUnderMusicDir } from './song-path.js';

const log = createLogger('library-deletion');

const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.flac',
  '.m4a',
  '.aac',
  '.ogg',
  '.opus',
  '.wav',
  '.wma',
  '.alac',
  '.aiff',
  '.aif',
  '.ape',
]);

export interface DeletionDeps {
  musicDir?: string;
  shareRescan: ShareRescanScheduler;
}

function lookupDownloadPath(navidromeId: string): string | null {
  try {
    const row = getDatabase()
      .query<{ relative_path: string }, [string]>(
        `SELECT relative_path FROM completed_downloads
         WHERE navidrome_id = ? AND relative_path IS NOT NULL LIMIT 1`,
      )
      .get(navidromeId);
    return row?.relative_path ?? null;
  } catch {
    return null;
  }
}

function lookupDownloadPathByBasename(fileBasename: string): string | null {
  try {
    const row = getDatabase()
      .query<{ relative_path: string }, [string]>(
        `SELECT relative_path FROM completed_downloads
         WHERE basename = ? AND relative_path IS NOT NULL
         ORDER BY completed_at DESC LIMIT 1`,
      )
      .get(fileBasename);
    return row?.relative_path ?? null;
  } catch {
    return null;
  }
}

function tokenizeFilename(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .split(/[\s\-_.]+/)
    .filter((t) => t.length >= 2);
}

function findFileByTokens(dir: string, tokens: string[]): string | null {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const tokenSet = new Set(tokens);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (tokenizeFilename(entry.name).some((t) => tokenSet.has(t))) {
      return join(dir, entry.name);
    }
  }
  return null;
}

function fuzzyFindFile(musicRootDir: string, fullPath: string): string | null {
  const tokens = tokenizeFilename(basename(fullPath));
  if (tokens.length === 0) return null;

  const knownDir = dirname(fullPath);
  if (existsSync(knownDir)) {
    const found = findFileByTokens(knownDir, tokens);
    if (found) return found;
  }

  let rootEntries: import('node:fs').Dirent[];
  try {
    rootEntries = readdirSync(musicRootDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const topEntry of rootEntries) {
    if (!topEntry.isDirectory()) continue;
    const topDir = join(musicRootDir, topEntry.name);
    const found = findFileByTokens(topDir, tokens);
    if (found) return found;
    // search one level deeper to cover the standard Artist/Album/track layout
    let subEntries: import('node:fs').Dirent[];
    try {
      subEntries = readdirSync(topDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const subEntry of subEntries) {
      if (!subEntry.isDirectory()) continue;
      const subFound = findFileByTokens(join(topDir, subEntry.name), tokens);
      if (subFound) return subFound;
    }
  }

  return null;
}

export function cleanupEmptyDirs(filePath: string, musicDir: string): void {
  const normalizedMusicDir = normalize(musicDir);
  let dir = dirname(filePath);
  while (true) {
    const normalizedDir = normalize(dir);
    if (normalizedDir === normalizedMusicDir || !normalizedDir.startsWith(normalizedMusicDir))
      break;
    try {
      if (readdirSync(normalizedDir).length === 0) {
        rmdirSync(normalizedDir);
        log.info({ dir: normalizedDir }, 'Removed empty directory after song deletion');
        dir = dirname(normalizedDir);
      } else {
        break;
      }
    } catch {
      break;
    }
  }
}

/**
 * Recursively delete an album's folder when it's safe to do so — the reliable
 * path for "Remove album" since it takes cover art and sidecar files (.nfo,
 * cover.jpg) with it, which per-file deletion leaves behind for Navidrome to
 * re-index. Returns false (caller falls back to per-file deletion) unless the
 * songs all share one album-specific directory that contains nothing foreign.
 */
export function tryDeleteAlbumFolder(songFullPaths: string[], expandedMusicDir: string): boolean {
  if (songFullPaths.length === 0) return false;

  const normalizedMusicDir = normalize(expandedMusicDir);
  const dirs = new Set(songFullPaths.map((p) => dirname(p)));
  if (dirs.size !== 1) return false; // multi-disc / scattered — let per-file handle it
  const dir = normalize([...dirs][0]!);

  // Must be album-specific: at least <Artist>/<Album> below the music root, and
  // never a shared "Singles" bucket.
  const rel = relative(normalizedMusicDir, dir);
  if (rel === '' || rel.startsWith('..')) return false;
  if (rel.split(/[\\/]/).filter(Boolean).length < 2) return false;
  if (basename(dir).toLowerCase() === 'singles') return false;

  // Refuse if the folder holds anything we didn't expect — a foreign audio file
  // (another album sharing the dir) or a subdirectory.
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  const albumFiles = new Set(songFullPaths.map((p) => normalize(p)));
  for (const entry of entries) {
    if (entry.isDirectory()) return false;
    if (!entry.isFile()) continue;
    const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
    if (AUDIO_EXTENSIONS.has(ext) && !albumFiles.has(normalize(join(dir, entry.name)))) {
      return false; // foreign audio — don't take it down with this album
    }
  }

  try {
    rmSync(dir, { recursive: true, force: true });
    log.info({ dir }, 'Removed album folder');
    cleanupEmptyDirs(dir, normalizedMusicDir); // climb to drop an now-empty <Artist>
    return true;
  } catch (err) {
    log.error({ err, dir }, 'Failed to remove album folder');
    return false;
  }
}

export interface DeleteOneResult {
  ok: boolean;
  error?: string;
  status?: number;
}

/** Delete one song's file (with fallback path resolution) + its DB rows. */
export async function deleteOne(
  db: Database,
  id: string,
  deps: DeletionDeps,
): Promise<DeleteOneResult> {
  const { musicDir, shareRescan } = deps;
  if (!musicDir) {
    return { ok: false, error: 'Music directory not configured', status: 500 };
  }

  const canonical = db
    .query<{ path: string; album_id: string | null }, [string]>(
      `SELECT path, album_id FROM library_songs WHERE id = ?`,
    )
    .get(id);
  const songPath: string | null = canonical?.path ?? null;
  // Captured before the row goes: the parent album's aggregates are recomputed
  // from its surviving songs afterwards (issue #774).
  const albumId: string | null = canonical?.album_id ?? null;
  if (!songPath) {
    return { ok: false, error: 'Song not found in library', status: 404 };
  }

  const expandedMusicDir = expandDir(musicDir);
  const fullPath = resolveSongPath(expandedMusicDir, songPath);

  if (!isUnderMusicDir(expandedMusicDir, fullPath)) {
    log.warn(
      { path: fullPath, musicDir: expandedMusicDir },
      'Resolved song path is outside the music directory',
    );
    return { ok: false, error: 'Song path is outside the music directory', status: 400 };
  }

  let deletedPath: string | null = null;

  if (existsSync(fullPath)) {
    try {
      unlinkSync(fullPath);
      deletedPath = fullPath;
      log.info({ path: fullPath, songId: id }, 'Deleted song file from disk');
    } catch (err) {
      log.error({ err, path: fullPath }, 'Failed to delete song file');
      return { ok: false, error: 'Failed to delete file', status: 500 };
    }
  } else {
    const registeredRelPath = lookupDownloadPath(id);
    const fileBasename = basename(fullPath).toLowerCase();
    const relPath = registeredRelPath ?? lookupDownloadPathByBasename(fileBasename);
    const fallbackPath = relPath ? join(expandedMusicDir, relPath) : null;
    if (fallbackPath && existsSync(fallbackPath)) {
      try {
        unlinkSync(fallbackPath);
        deletedPath = fallbackPath;
        log.info(
          { requestedPath: fullPath, resolvedPath: fallbackPath },
          'Deleted song file via fallback path',
        );
      } catch (err) {
        log.error({ err, path: fallbackPath }, 'Failed to delete song file');
        return { ok: false, error: 'Failed to delete file', status: 500 };
      }
    } else {
      const fuzzyPath = fuzzyFindFile(expandedMusicDir, fullPath);
      if (fuzzyPath) {
        try {
          unlinkSync(fuzzyPath);
          deletedPath = fuzzyPath;
          log.info(
            { requestedPath: fullPath, resolvedPath: fuzzyPath },
            'Deleted song file via fuzzy path match',
          );
        } catch (err) {
          log.error({ err, path: fuzzyPath }, 'Failed to delete song file');
          return { ok: false, error: 'Failed to delete file', status: 500 };
        }
      } else {
        log.warn(
          { songId: id, expectedPath: fullPath },
          'Song file not found on disk; no fallback path resolved',
        );
        // File is already gone — clean up the orphaned DB record so it stops appearing in Navidrome.
        const orphan = db
          .query<{ id: string }, [string]>(`SELECT id FROM library_songs WHERE id = ?`)
          .get(id);
        if (orphan) {
          try {
            db.run('DELETE FROM completed_downloads WHERE navidrome_id = ?', [id]);
            db.run('DELETE FROM library_songs WHERE id = ?', [id]);
            if (albumId) pruneOrphanAlbum(db, albumId);
          } catch (err) {
            log.debug({ err }, 'Failed to remove orphaned record');
          }
          // The file was already gone from disk but slskd may not know yet —
          // rescan so it stops advertising it.
          shareRescan.schedule();
          return { ok: true };
        }
        return { ok: false, error: 'Song file not found on disk', status: 404 };
      }
    }
  }

  if (deletedPath) {
    shareRescan.schedule();
    cleanupEmptyDirs(deletedPath, expandedMusicDir);
    const relPath = relative(expandedMusicDir, deletedPath).replace(/\\/g, '/');

    try {
      db.run('DELETE FROM completed_downloads WHERE navidrome_id = ? OR relative_path = ?', [
        id,
        relPath,
      ]);
      db.run('DELETE FROM library_songs WHERE id = ?', [id]);
      if (albumId) pruneOrphanAlbum(db, albumId);
      log.info({ relPath }, 'Removed song from completion history + canonical DB');
    } catch (err) {
      log.debug({ err }, 'Failed to remove from completion history');
    }
  }

  return { ok: true };
}

export interface DeleteAlbumResult {
  ok: boolean;
  deletedCount: number;
  failedCount: number;
  failed: Array<{ id: string; error: string }>;
  /** Enough for the caller to build a recordAudit detail string. */
  albumRow: { name: string; artist: string } | null;
}

/**
 * Full album deletion: folder-first `tryDeleteAlbumFolder`, falling back to
 * per-song `deleteOne`, then the canonical-row transaction (songs, album,
 * orphan-artist prune, orphan-genre prune, artwork). Callers (the HTTP route,
 * the MCP `delete_album` tool) call `recordAudit` themselves using the
 * returned `albumRow`/counts — this function only performs the deletion.
 */
export async function deleteAlbum(
  db: Database,
  albumId: string,
  deps: DeletionDeps,
): Promise<DeleteAlbumResult | null> {
  const { musicDir, shareRescan } = deps;

  const albumRow = db
    .query<
      { name: string; artist: string; artist_id: string | null; genre: string | null },
      [string]
    >('SELECT name, artist, artist_id, genre FROM library_albums WHERE id = ?')
    .get(albumId);
  const canonicalSongs = db
    .query<{ id: string; path: string; artist_id: string | null }, [string]>(
      'SELECT id, path, artist_id FROM library_songs WHERE album_id = ?',
    )
    .all(albumId);
  const songIds: string[] = canonicalSongs.map((s) => s.id);
  const songPaths: string[] = canonicalSongs.map((s) => s.path);

  if (songIds.length === 0 && !albumRow) {
    return null;
  }

  const failed: Array<{ id: string; error: string }> = [];
  let deletedCount = 0;

  // Reliable path: drop the whole album folder in one shot. Falls back to
  // per-file deletion for scattered/multi-disc tracks and shared "Singles".
  let folderDeleted = false;
  if (musicDir && songPaths.length > 0 && songPaths.length === songIds.length) {
    const expandedMusicDir = expandDir(musicDir);
    const fullPaths = songPaths
      .map((p) => resolveSongPath(expandedMusicDir, p))
      .filter((p) => isUnderMusicDir(expandedMusicDir, p));
    if (fullPaths.length === songPaths.length) {
      folderDeleted = tryDeleteAlbumFolder(fullPaths, expandedMusicDir);
    }
  }

  if (folderDeleted) {
    deletedCount = songIds.length;
    shareRescan.schedule();
  } else {
    const results = await Promise.allSettled(songIds.map((id) => deleteOne(db, id, deps)));
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled' && r.value.ok) {
        deletedCount++;
      } else {
        const err = r.status === 'fulfilled' ? r.value.error : 'Unexpected error';
        failed.push({ id: songIds[i]!, error: err ?? 'Unknown error' });
      }
    }
  }

  // Remove the album from the canonical tables synchronously. The scanner reads
  // straight from disk (and the files are now gone), so a later rescan won't
  // resurrect it — no tombstone/async-scan reconciliation needed.
  db.transaction(() => {
    if (songIds.length > 0) {
      const placeholders = songIds.map(() => '?').join(',');
      db.run(`DELETE FROM completed_downloads WHERE navidrome_id IN (${placeholders})`, songIds);
    }
    db.run('DELETE FROM library_songs WHERE album_id = ?', [albumId]);
    db.run('DELETE FROM library_albums WHERE id = ?', [albumId]);

    // Clean up the aggregate rows the canonical-row delete would otherwise
    // leave stale until the next *full* scan. Without this, deleting an
    // artist's only release orphans its `library_artists` row: the artist
    // keeps showing in search (the local provider reads `library_artists`)
    // and its page renders empty (`/artists/:id` returns the shell from
    // `library_artists` with no albums). See
    // docs/e2e-playground-findings-2026-06.md §D.
    const artistId = albumRow?.artist_id ?? canonicalSongs.find((s) => s.artist_id)?.artist_id;
    if (artistId) pruneOrphanArtist(db, artistId);

    // Drop a genre row only once nothing references it — recomputing exact
    // counts for a large shared genre on every delete isn't worth it (a full
    // scan refreshes them), but a genre that's now empty should disappear.
    const genre = albumRow?.genre;
    if (genre) {
      const stillUsed =
        db.query('SELECT 1 FROM library_albums WHERE genre = ? LIMIT 1').get(genre) !== null ||
        db.query('SELECT 1 FROM library_songs WHERE genre = ? LIMIT 1').get(genre) !== null;
      if (!stillUsed) db.run('DELETE FROM library_genres WHERE name = ?', [genre]);
    }

    // The album's own canonical artwork row survives rescans by design, but a
    // deleted album should not keep one.
    db.run('DELETE FROM library_artwork WHERE id = ?', [albumId]);
  })();

  log.info(
    { albumId, deletedCount, failedCount: failed.length, folderDeleted },
    'Album deletion complete',
  );

  return {
    ok: failed.length === 0,
    deletedCount,
    failedCount: failed.length,
    failed,
    albumRow: albumRow ? { name: albumRow.name, artist: albumRow.artist } : null,
  };
}
