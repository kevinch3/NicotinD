import type { FolderCandidate } from '../services/api/api-types';
import { folderAudioFiles, folderFormat, type FolderGroup } from './folder-utils';

/**
 * One copy of a work a source holds — a peer's folder today, scored or not.
 * The picker shows every copy through this one shape, whichever lane found it.
 */
export interface CopyCandidate {
  /** `username::directory`, the identity a scored and an unscored row share. */
  key: string;
  username: string;
  directory: string;
  /** Audio files this copy carries. */
  tracks: number;
  /** The release's track count, when known. */
  totalTracks?: number;
  /** The hunt's score; absent on a copy nobody scored. */
  matchPct?: number;
  format: string | null;
  lossless: boolean;
  sizeBytes: number;
  freeSlot: boolean;
  queueLength: number;
  /** What a Get of this copy enqueues. */
  folder: FolderGroup;
  /** The hunt's candidate, when the hunt scored this copy: a Get goes through hunt-download. */
  scored?: FolderCandidate;
}

export const copyKey = (username: string, directory: string): string => `${username}::${directory}`;

export function folderToCopy(group: FolderGroup, totalTracks?: number): CopyCandidate {
  const audio = folderAudioFiles(group);
  const format = folderFormat(group);
  return {
    key: copyKey(group.username, group.directory),
    username: group.username,
    directory: group.directory,
    tracks: audio.length,
    ...(totalTracks ? { totalTracks } : {}),
    format: format?.label ?? null,
    lossless: format?.lossless ?? false,
    sizeBytes: audio.reduce((sum, f) => sum + (f.size || 0), 0),
    freeSlot: (group.freeUploadSlots ?? 0) > 0,
    queueLength: group.queueLength ?? 0,
    folder: group,
  };
}

export function huntToCopy(c: FolderCandidate): CopyCandidate {
  const folder: FolderGroup = {
    username: c.username,
    directory: c.directory,
    uploadSpeed: c.uploadSpeed,
    queueLength: c.queueLength,
    freeUploadSlots: c.freeUploadSlots,
    files: c.files.map((f) => ({ filename: f.filename, size: f.size })),
  };
  return {
    key: copyKey(c.username, c.directory),
    username: c.username,
    directory: c.directory,
    tracks: c.matchedTracks,
    totalTracks: c.totalTracks,
    matchPct: c.matchPct,
    format: c.format || null,
    lossless: /^(flac|wav|alac|ape|wv|aiff?)$/i.test(c.format),
    sizeBytes: Math.round(c.estimatedSizeMb * 1024 * 1024),
    freeSlot: c.freeUploadSlots > 0,
    queueLength: c.queueLength,
    folder,
    scored: c,
  };
}

/**
 * Scored copies first, in the hunt's order, then the copies only the page search
 * saw. A copy both found keeps the score.
 */
export function mergeCopies(
  scored: readonly CopyCandidate[],
  unscored: readonly CopyCandidate[],
): CopyCandidate[] {
  const seen = new Set(scored.map((c) => c.key));
  return [...scored, ...unscored.filter((c) => !seen.has(c.key))];
}

/** The leaf folder name, for a row that has no room for the whole path. */
export function copyFolderName(c: Pick<CopyCandidate, 'directory'>): string {
  return c.directory.split(/[\\/]/).filter(Boolean).at(-1) ?? c.directory;
}
