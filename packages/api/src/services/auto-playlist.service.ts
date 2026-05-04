import { basename } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { Navidrome } from '@nicotind/navidrome-client';
import { createLogger } from '@nicotind/core';
import type { Playlist } from '@nicotind/core';
import { getDatabase } from '../db.js';
import type { CompletedDownloadFile } from './metadata-fixer.js';

const log = createLogger('auto-playlist');

export const ALL_SINGLES = 'All Singles';

function normalizePath(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

/** Strips the music directory prefix from an absolute Navidrome song path. */
export function normalizeSongPath(musicDir: string, absolutePath: string): string {
  const prefix = normalizePath(musicDir).replace(/\/+$/, '') + '/';
  const normalized = normalizePath(absolutePath);
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
}

/** Extracts the leaf folder name and strips audio quality/format tags. */
export function cleanFolderName(raw: string): string {
  // Extract leaf segment (handles both \ and / separators)
  const leaf = raw.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? raw;

  // Strip bracketed tags: [FLAC 320kbps], [MP3 V0], [WEB], [CDRip], etc.
  let cleaned = leaf.replace(/\s*\[[^\]]*\]/g, '');

  // Strip parenthesized audio format names — but NOT years like (2020)
  cleaned = cleaned.replace(
    /\s*\((FLAC|MP3|WAV|AAC|OGG|OPUS|AIFF|ALAC|WMA|APE|LOSSLESS)\)/gi,
    '',
  );

  // Trim trailing whitespace and stray punctuation
  cleaned = cleaned.trim().replace(/[\s\-_]+$/, '').trim();

  return cleaned || leaf;
}

/** Groups completed files by their slskd directory field. */
export function groupByDirectory(
  files: CompletedDownloadFile[],
): Map<string, CompletedDownloadFile[]> {
  const groups = new Map<string, CompletedDownloadFile[]>();
  for (const file of files) {
    const group = groups.get(file.directory) ?? [];
    group.push(file);
    groups.set(file.directory, group);
  }
  return groups;
}

/**
 * Automatically places completed downloads into Navidrome playlists.
 * Single-file downloads go to "All Singles"; multi-file folder downloads
 * go to a playlist named after the cleaned folder. All playlists are owned
 * by the admin Navidrome user (the `navidrome` client instance carries admin credentials).
 */
export class AutoPlaylistService {
  constructor(
    private navidrome: Navidrome,
    private musicDir = '',
    private scanTimeoutMs = 30_000,
    private db?: Database | null,
    private adminUserId?: string,
  ) {}

  /**
   * One-time startup migration: finds completed_downloads records without a
   * navidrome_id, builds a full path index from all Navidrome albums, and
   * back-fills the navidrome_id column. Best-effort — errors are logged, not thrown.
   */
  async migrateNavidromeIds(): Promise<void> {
    let unmapped: Array<{ transfer_key: string; relative_path: string }>;
    try {
      unmapped = getDatabase()
        .query<{ transfer_key: string; relative_path: string }, []>(
          `SELECT transfer_key, relative_path FROM completed_downloads
           WHERE navidrome_id IS NULL AND relative_path IS NOT NULL`,
        )
        .all();
    } catch {
      return; // DB not ready
    }

    if (unmapped.length === 0) return;
    log.info({ count: unmapped.length }, 'Migrating navidrome_id for existing downloads');

    const pathIndex = await this.buildFullPathIndex();
    if (pathIndex.size === 0) return;

    const db = getDatabase();
    let updated = 0;
    for (const row of unmapped) {
      const navidromeId = pathIndex.get(normalizePath(row.relative_path));
      if (navidromeId) {
        db.run(
          `UPDATE completed_downloads SET navidrome_id = ? WHERE transfer_key = ?`,
          [navidromeId, row.transfer_key],
        );
        updated++;
      }
    }

    log.info({ total: unmapped.length, updated }, 'navidrome_id migration complete');
  }

  /** Builds a relativePath→songId index by paging through all Navidrome albums. */
  private async buildFullPathIndex(): Promise<Map<string, string>> {
    const pathIndex = new Map<string, string>();
    let offset = 0;

    while (true) {
      let albums: Awaited<ReturnType<typeof this.navidrome.browsing.getAlbumList>>;
      try {
        albums = await this.navidrome.browsing.getAlbumList('alphabeticalByName', 500, offset);
      } catch {
        break;
      }
      if (albums.length === 0) break;

      await Promise.all(
        albums.map(async (album) => {
          try {
            const { songs } = await this.navidrome.browsing.getAlbum(album.id);
            for (const song of songs) {
              pathIndex.set(normalizeSongPath(this.musicDir, song.path), song.id);
            }
          } catch {
            // Skip unreachable album
          }
        }),
      );

      offset += albums.length;
      if (albums.length < 500) break;
    }

    return pathIndex;
  }

  /**
   * Groups `files` by directory, determines playlist names, and creates or
   * appends to Navidrome playlists. Best-effort — errors are logged, not thrown.
   */
  async processBatch(files: CompletedDownloadFile[]): Promise<void> {
    if (files.length === 0) return;

    await this.waitForScan();

    let allPlaylists: Playlist[];
    try {
      allPlaylists = await this.navidrome.playlists.list();
    } catch (err) {
      log.error({ err }, 'Failed to list playlists, aborting auto-playlist batch');
      return;
    }

    const [pathIndex, recentIndex] = await Promise.all([
      this.buildPathIndex(files),
      this.buildRecentSongIndex(),
    ]);

    const groups = groupByDirectory(files);
    for (const [directory, groupFiles] of groups) {
      const isFolderDownload = groupFiles.length > 1 ||
        groupFiles.some((file) => (file.directoryFileCount ?? 1) > 1);
      const name = isFolderDownload ? cleanFolderName(directory) : ALL_SINGLES;
      await this.processGroup(name, groupFiles, allPlaylists, pathIndex, recentIndex);
    }
  }

  /** Polls getScanStatus until the scan finishes or the timeout is reached. */
  private async waitForScan(): Promise<void> {
    const deadline = Date.now() + this.scanTimeoutMs;
    // Allow up to 5 s for Navidrome to start the scan after startScan() returns.
    const startDeadline = Date.now() + Math.min(this.scanTimeoutMs, 5_000);
    let sawScanning = false;
    do {
      try {
        const status = await this.navidrome.system.getScanStatus();
        if (status.scanning) {
          sawScanning = true;
        } else if (sawScanning) {
          return; // Scan started and finished — proceed.
        } else if (Date.now() >= startDeadline) {
          return; // Never saw scan start (may have finished before first poll).
        }
      } catch {
        return;
      }
      if (Date.now() >= deadline) return;
      await new Promise((r) => setTimeout(r, 500));
    } while (true);
  }

  /** Finds or creates a playlist by name, then appends new song IDs. */
  private async processGroup(
    name: string,
    files: CompletedDownloadFile[],
    allPlaylists: Playlist[],
    pathIndex: Map<string, string>,
    recentIndex: Map<string, Array<{ path: string; id: string }>>,
  ): Promise<void> {
    const resolvedSongIds: string[] = [];
    const seenResolved = new Set<string>();
    for (const file of files) {
      const id = await this.resolveSongId(file, pathIndex, recentIndex);
      if (!id) {
        log.warn({ filename: file.filename }, 'Could not resolve Navidrome song ID, skipping');
        continue;
      }
      this.persistNavidromeId(file, id);
      if (!seenResolved.has(id)) {
        seenResolved.add(id);
        resolvedSongIds.push(id);
      }
    }

    if (resolvedSongIds.length === 0) {
      log.warn({ name, count: files.length }, 'No tracks resolved for playlist group, skipping');
      return;
    }

    let playlist = allPlaylists.find((p) => p.name === name);
    if (!playlist) {
      try {
        playlist = await this.navidrome.playlists.create(name);
        allPlaylists.push(playlist); // keep local cache in sync for subsequent groups
        this.persistPlaylistVisibility(playlist.id);
      } catch (err) {
        log.error({ err, name }, 'Failed to create playlist');
        return;
      }
    }

    let existingSongIds = new Set<string>();
    try {
      const full = await this.navidrome.playlists.get(playlist.id);
      existingSongIds = new Set(full.entry?.map((s) => s.id) ?? []);
    } catch (err) {
      log.warn({ err, name }, 'Failed to fetch existing playlist tracks, proceeding without dedup');
    }

    const songIdsToAdd = resolvedSongIds.filter((id) => !existingSongIds.has(id));

    if (songIdsToAdd.length === 0) return;

    try {
      await this.navidrome.playlists.update(playlist.id, { songIdsToAdd });
      log.info({ name, added: songIdsToAdd.length }, 'Auto-playlist updated');
    } catch (err) {
      log.error({ err, name }, 'Failed to update playlist');
    }
  }

  /**
   * Searches Navidrome for a song matching a completed download.
   * Priority: 1) exact relative-path lookup in pathIndex, 2) basename lookup
   * in recentIndex (recently added albums — reliable when scan just ran),
   * 3) text search by filename stem as last resort.
   * Returns the song ID or null if not found.
   */
  private async resolveSongId(
    file: CompletedDownloadFile,
    pathIndex: Map<string, string>,
    recentIndex: Map<string, Array<{ path: string; id: string }>>,
  ): Promise<string | null> {
    const relativePath = this.resolveRelativePathHint(file);

    if (relativePath) {
      const indexedId = pathIndex.get(relativePath);
      if (indexedId) return indexedId;
    }

    const fileBasename = basename(file.filename.replace(/\\/g, '/')).toLowerCase();

    // Recent-albums fast path. When there is exactly one candidate for this
    // basename, use it immediately. When there are multiple (filename collision
    // across albums), require a path match to avoid assigning the wrong song —
    // and therefore the wrong cover art — to a playlist.
    const recentCandidates = recentIndex.get(fileBasename);
    if (recentCandidates) {
      if (recentCandidates.length === 1) return recentCandidates[0].id;
      if (relativePath) {
        const match = recentCandidates.find((e) => e.path === relativePath);
        if (match) return match.id;
      }
      // Collision and no path to disambiguate — fall through to text search.
    }

    const nameWithoutExt = fileBasename.replace(/\.[^.]+$/, '');
    const maxAttempts = this.scanTimeoutMs === 0 ? 1 : 5;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const results = await this.navidrome.search.search3(nameWithoutExt, {
          songCount: 25, // 25 to handle common track names (e.g. "01 Track") in large libraries
          artistCount: 0,
          albumCount: 0,
        });

        if (relativePath) {
          const pathMatch = results.song.find(
            (song) => normalizeSongPath(this.musicDir, song.path) === relativePath,
          );
          if (pathMatch) return pathMatch.id;
        }

        const basenameMatch = results.song.find(
          (song) => basename(normalizePath(song.path)) === fileBasename,
        );
        if (basenameMatch) return basenameMatch.id;
      } catch {
        return null;
      }

      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    return null;
  }

  /**
   * Pre-builds a path→songId index by browsing Navidrome albums that match
   * the download directories. This is more reliable than text-searching by
   * filename because Navidrome's search3 queries song titles, not filenames.
   * Returns an empty map when no relative paths are available (graceful degradation).
   */
  private async buildPathIndex(files: CompletedDownloadFile[]): Promise<Map<string, string>> {
    const pathIndex = new Map<string, string>();

    const albumNames = new Set<string>();
    for (const file of files) {
      const rp = this.resolveRelativePathHint(file);
      if (!rp) continue;
      const parts = rp.split('/').filter(Boolean);
      if (parts.length < 2) continue;
      const albumDir = parts[parts.length - 2];
      const cleaned = cleanFolderName(albumDir);
      if (cleaned) albumNames.add(cleaned);
    }

    for (const albumName of albumNames) {
      try {
        const results = await this.navidrome.search.search3(albumName, {
          albumCount: 5,
          songCount: 0,
          artistCount: 0,
        });
        for (const album of results.album) {
          try {
            const { songs } = await this.navidrome.browsing.getAlbum(album.id);
            for (const song of songs) {
              pathIndex.set(normalizeSongPath(this.musicDir, song.path), song.id);
            }
          } catch {
            // continue with next album
          }
        }
      } catch {
        // continue with next album name
      }
    }

    return pathIndex;
  }

  /**
   * Builds a filename-basename → [{normalizedPath, songId}] index from the
   * most recently added albums. Returns ALL candidates per basename so that
   * callers can disambiguate by path when filenames collide across albums
   * (e.g. two albums both having "01 - Track.flac"). Only fetches albums whose
   * names are related to the current batch to keep the lookup cheap.
   */
  private async buildRecentSongIndex(): Promise<Map<string, Array<{ path: string; id: string }>>> {
    const index = new Map<string, Array<{ path: string; id: string }>>();
    try {
      const albums = await this.navidrome.browsing.getAlbumList('newest', 200, 0);
      await Promise.all(
        albums.map(async (album) => {
          try {
            const { songs } = await this.navidrome.browsing.getAlbum(album.id);
            for (const song of songs) {
              const normalizedPath = normalizeSongPath(this.musicDir, song.path);
              const base = basename(normalizedPath);
              const entries = index.get(base) ?? [];
              entries.push({ path: normalizedPath, id: song.id });
              index.set(base, entries);
            }
          } catch { /* skip unreachable album */ }
        }),
      );
    } catch { /* proceed with empty index */ }
    return index;
  }

  private persistPlaylistVisibility(playlistId: string): void {
    try {
      const db = this.db ?? getDatabase();
      const adminId = this.adminUserId ?? db
        .query<{ id: string }, []>("SELECT id FROM users WHERE role = 'admin' LIMIT 1")
        .get()?.id;
      if (!adminId) return;
      db.run(
        'INSERT OR IGNORE INTO playlist_visibility (playlist_id, owner_id, visibility) VALUES (?, ?, ?)',
        [playlistId, adminId, 'global'],
      );
    } catch {
      // Non-fatal: DB may not be available in tests or early startup
    }
  }

  private persistNavidromeId(file: CompletedDownloadFile, navidromeId: string): void {
    try {
      getDatabase().run(
        `UPDATE completed_downloads SET navidrome_id = ?
         WHERE username = ? AND directory = ? AND filename = ?`,
        [navidromeId, file.username, file.directory, file.filename],
      );
    } catch {
      // Non-fatal: DB may not be available in tests or early startup
    }
  }

  private resolveRelativePathHint(file: CompletedDownloadFile): string | null {
    if (file.relativePath && file.relativePath.trim().length > 0) {
      return normalizePath(file.relativePath);
    }

    try {
      const db = getDatabase();
      const row = db
        .query<{ relative_path: string | null }, [string, string, string]>(
          `SELECT relative_path
           FROM completed_downloads
           WHERE username = ? AND directory = ? AND filename = ? AND relative_path IS NOT NULL
           ORDER BY completed_at DESC
           LIMIT 1`,
        )
        .get(file.username, file.directory, file.filename);

      if (row?.relative_path && row.relative_path.trim().length > 0) {
        return normalizePath(row.relative_path);
      }
    } catch {
      // DB not available in tests/early startup: continue without path hint.
    }

    return null;
  }
}
