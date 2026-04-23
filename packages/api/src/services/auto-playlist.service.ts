import { basename } from 'node:path';
import { createLogger } from '@nicotind/core';
import type { Navidrome } from '@nicotind/navidrome-client';
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

  async processBatch(_files: CompletedDownloadFile[]): Promise<void> {
    // Implemented in Task 2
  }
}
