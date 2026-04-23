import { basename } from 'node:path';
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
    private scanTimeoutMs = 30_000,
  ) {}

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

    const groups = groupByDirectory(files);
    for (const [directory, groupFiles] of groups) {
      const isFolderDownload = groupFiles.length > 1 ||
        groupFiles.some((file) => (file.directoryFileCount ?? 1) > 1);
      const name = isFolderDownload ? cleanFolderName(directory) : ALL_SINGLES;
      await this.processGroup(name, groupFiles, allPlaylists);
    }
  }

  /** Polls getScanStatus until the scan finishes or the timeout is reached. */
  private async waitForScan(): Promise<void> {
    const deadline = Date.now() + this.scanTimeoutMs;
    let sawScanning = false;
    let idlePolls = 0;
    do {
      try {
        const status = await this.navidrome.system.getScanStatus();
        if (status.scanning) {
          sawScanning = true;
          idlePolls = 0;
        } else {
          idlePolls += 1;
          // Require two idle polls unless we've already observed an active scan.
          if (sawScanning || idlePolls >= 2) return;
        }
      } catch {
        return; // If we can't query status, proceed anyway
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
  ): Promise<void> {
    const resolvedSongIds: string[] = [];
    const seenResolved = new Set<string>();
    for (const file of files) {
      const id = await this.resolveSongId(file);
      if (!id) {
        log.warn({ filename: file.filename }, 'Could not resolve Navidrome song ID, skipping');
        continue;
      }
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
   * Prefers relative-path matches, then falls back to basename.
   * Returns the song ID or null if not found.
   */
  private async resolveSongId(file: CompletedDownloadFile): Promise<string | null> {
    const relativePath = this.resolveRelativePathHint(file);
    const fileBasename = basename(file.filename.replace(/\\/g, '/')).toLowerCase();
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
            (song) => normalizePath(song.path) === relativePath,
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
