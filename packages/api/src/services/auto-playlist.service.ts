import { basename } from 'node:path';
import type { Navidrome } from '@nicotind/navidrome-client';
import { createLogger } from '@nicotind/core';
import type { Playlist } from '@nicotind/core';
import type { CompletedDownloadFile } from './metadata-fixer.js';

const log = createLogger('auto-playlist');

export const ALL_SINGLES = 'All Singles';

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
      const name = groupFiles.length === 1 ? ALL_SINGLES : cleanFolderName(directory);
      await this.processGroup(name, groupFiles, allPlaylists);
    }
  }

  /** Polls getScanStatus until the scan finishes or the timeout is reached. */
  private async waitForScan(): Promise<void> {
    const deadline = Date.now() + this.scanTimeoutMs;
    do {
      try {
        const status = await this.navidrome.system.getScanStatus();
        if (!status.scanning) return;
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

    const songIdsToAdd: string[] = [];
    for (const file of files) {
      const id = await this.resolveSongId(file);
      if (!id) {
        log.warn({ filename: file.filename }, 'Could not resolve Navidrome song ID, skipping');
        continue;
      }
      if (!existingSongIds.has(id)) {
        songIdsToAdd.push(id);
      }
    }

    if (songIdsToAdd.length === 0) return;

    try {
      await this.navidrome.playlists.update(playlist.id, { songIdsToAdd });
      log.info({ name, added: songIdsToAdd.length }, 'Auto-playlist updated');
    } catch (err) {
      log.error({ err, name }, 'Failed to update playlist');
    }
  }

  /**
   * Searches Navidrome for a song matching the file's basename.
   * Returns the song ID or null if not found.
   */
  // V1: match by basename only. A more precise approach would compare Song.path
  // against the file's relativePath (computed at download time), but that field
  // is not available on CompletedDownloadFile. Basename matching is sufficient for
  // most cases but may pick the wrong song if two tracks share the same filename.
  private async resolveSongId(file: CompletedDownloadFile): Promise<string | null> {
    const fileBasename = basename(file.filename.replace(/\\/g, '/')).toLowerCase();
    const nameWithoutExt = fileBasename.replace(/\.[^.]+$/, '');

    try {
      const results = await this.navidrome.search.search3(nameWithoutExt, {
        songCount: 25, // 25 to handle common track names (e.g. "01 Track") in large libraries
        artistCount: 0,
        albumCount: 0,
      });
      const match = results.song.find(
        (s) => basename(s.path).toLowerCase() === fileBasename,
      );
      return match?.id ?? null;
    } catch {
      return null;
    }
  }
}
