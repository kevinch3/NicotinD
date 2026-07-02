export interface SlskdSession {
  token: string;
  username: string;
}

export interface SlskdSearch {
  id: string;
  searchText: string;
  state: string;
  responseCount: number;
  fileCount: number;
}

export interface SlskdSearchResponse {
  username: string;
  fileCount: number;
  lockedFileCount: number;
  freeUploadSlots: number;
  uploadSpeed: number;
  queueLength: number;
  files: SlskdFile[];
}

export interface SlskdFile {
  filename: string;
  size: number;
  bitRate?: number;
  sampleRate?: number;
  bitDepth?: number;
  length?: number;
  code: string;
}

export type SlskdTransferState =
  | 'Requested'
  | 'Queued, Locally'
  | 'Queued, Remotely'
  | 'Initializing'
  | 'InProgress'
  | 'Completed, Succeeded'
  | 'Completed, Cancelled'
  | 'Completed, TimedOut'
  | 'Completed, Errored'
  | 'Completed, Rejected';

export interface SlskdTransfer {
  id: string;
  username: string;
  filename: string;
  size: number;
  state: SlskdTransferState;
  bytesTransferred: number;
  averageSpeed: number;
  percentComplete: number;
  startedAt?: string;
  endedAt?: string;
}

/**
 * Canonical hunt metadata for a download folder, attached server-side when the
 * folder's peer directory matches an active album-hunt job. Lets the Downloads
 * UI label a transfer with the real artist/album (and expected track count)
 * instead of the noisy peer folder name (e.g. "(1995) Toque" → "Babasónicos —
 * Trance Zomba"). Absent for direct (non-hunt) Soulseek downloads.
 */
export interface AlbumJobMeta {
  artistName: string;
  albumTitle: string;
  /** Canonical Lidarr tracklist length — the "of N" the album should contain. */
  canonicalTrackCount: number;
  /** Deterministic library album id for the destination album, for deep-linking. */
  albumId: string;
}

export interface SlskdTransferDirectory {
  directory: string;
  fileCount: number;
  files: SlskdTransfer[];
  albumJob?: AlbumJobMeta;
}

export interface SlskdUserTransferGroup {
  username: string;
  directories: SlskdTransferDirectory[];
}

export interface SlskdDownloadRequest {
  username: string;
  files: Array<{
    filename: string;
    size: number;
  }>;
}

export interface SlskdServerState {
  state: string;
  username: string;
  isConnected: boolean;
}

export interface SlskdApplicationInfo {
  version: string;
  uptime: number;
}

export interface SlskdShareDirectory {
  path: string;
  fileCount?: number;
}
