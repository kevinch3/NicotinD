import type { SlskdUserTransferGroup } from '@nicotind/core';

export interface AlbumGroup {
  key: string;
  /** Peer folder name — fallback label for direct (non-hunt) downloads. */
  name: string;
  /** Canonical hunt metadata, present when the folder was acquired via a hunt. */
  artistName?: string;
  albumTitle?: string;
  /** Canonical Lidarr track count — the "of N" the album should contain. */
  expectedTracks?: number;
  username: string;
  fileIds: string[];
  erroredFileIds: string[];
  totalFiles: number;
  completedFiles: number;
  overallPercent: number;
  state: 'downloading' | 'queued' | 'done' | 'error';
}

/** Last path segment of a backslash-separated peer directory. */
export function extractAlbumName(directory: string): string {
  const segments = directory.split('\\').filter(Boolean);
  return segments[segments.length - 1] ?? directory;
}

/**
 * The primary label for a download row: the canonical album title when the
 * folder came from a hunt, otherwise the peer folder name.
 */
export function albumGroupTitle(g: AlbumGroup): string {
  return g.albumTitle ?? g.name;
}

/** The number to show as the "of N" total: canonical track count if known. */
export function albumGroupTotal(g: AlbumGroup): number {
  return g.expectedTracks && g.expectedTracks > 0 ? g.expectedTracks : g.totalFiles;
}

const STATE_ORDER: Record<AlbumGroup['state'], number> = {
  downloading: 0,
  queued: 1,
  error: 2,
  done: 3,
};

/**
 * Group slskd transfers by peer folder into per-album rows, carrying through any
 * canonical hunt metadata the server attached (`albumJob`). Sorted
 * downloading → queued → error → done.
 */
export function groupByAlbum(downloads: SlskdUserTransferGroup[]): AlbumGroup[] {
  const groups: AlbumGroup[] = [];
  for (const transfer of downloads) {
    for (const dir of transfer.directories) {
      const name = extractAlbumName(dir.directory);
      const key = `${transfer.username}:${dir.directory}`;
      const files = dir.files;
      const completed = files.filter((f) => f.state.includes('Succeeded')).length;
      const active = files.filter((f) => f.state === 'InProgress').length;
      const erroredFiles = files.filter(
        (f) =>
          f.state.includes('Errored') ||
          f.state.includes('Cancelled') ||
          f.state.includes('TimedOut') ||
          f.state.includes('Rejected'),
      );
      const errored = erroredFiles.length;
      const totalBytes = files.reduce((s, f) => s + f.size, 0);
      const transferredBytes = files.reduce((s, f) => s + f.bytesTransferred, 0);
      const overallPercent = totalBytes > 0 ? Math.round((transferredBytes / totalBytes) * 100) : 0;

      let state: AlbumGroup['state'] = 'queued';
      if (completed === files.length) state = 'done';
      else if (active > 0) state = 'downloading';
      else if (errored > 0 && completed + errored === files.length) state = 'error';

      groups.push({
        key,
        name,
        artistName: dir.albumJob?.artistName,
        albumTitle: dir.albumJob?.albumTitle,
        expectedTracks: dir.albumJob?.canonicalTrackCount,
        username: transfer.username,
        fileIds: files.map((f) => f.id),
        erroredFileIds: erroredFiles.map((f) => f.id),
        totalFiles: files.length,
        completedFiles: completed,
        overallPercent,
        state,
      });
    }
  }
  return groups.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);
}
