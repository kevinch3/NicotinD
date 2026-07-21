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
  /**
   * Dominant bitrate (kbps) of the files in this directory, sourced from the
   * slskd search response at enqueue time (`SlskdFile.bitRate`). Aggregated
   * server-side by `enrichWithBitrate` so the download card can render
   * "· 320 kbps" without each transfer having to carry it. Optional: legacy
   * rows without bitrate data stay undefined and the chip is hidden.
   */
  bitrateKbps?: number;
  /**
   * Codec/format string for the directory, e.g. "FLAC", "MP3", "Opus". Sourced
   * from `detectFormat` in album-hunter.service.ts. Always shown alongside
   * the bitrate for lossless codecs (FLAC, WAV), optional for lossy.
   */
  audioFormat?: string;
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

/** Share roll-up as reported by slskd's `/api/v0/application` `shares` block. */
export interface SlskdShareStats {
  directories?: number;
  files?: number;
}

export interface SlskdApplicationInfo {
  version: string;
  uptime: number;
  /**
   * Live server block from slskd's `/api/v0/application`. Optional because older
   * slskd builds (and the minimal shape the DownloadWatcher uptime probe relies
   * on) may omit it; the status endpoint falls back to `server.getState()`.
   */
  server?: SlskdServerState;
  /** Shared library size, when slskd reports it. */
  shares?: SlskdShareStats;
}

/** Aggregate live transfer speeds, bytes/sec, summed over in-progress transfers. */
export interface SlskdSpeeds {
  downloadBytesPerSec: number;
  uploadBytesPerSec: number;
}

/** Transfer activity roll-up used by the slskd extension status panel. */
export interface SlskdTransferCounts {
  downloading: number;
  uploading: number;
  queued: number;
}

/**
 * Global transfer limits parsed from slskd's runtime options. All optional — the
 * exact slskd options JSON shape varies by version, so the extractor is
 * best-effort and the UI shows "—" for anything it can't resolve. Speed limits
 * are in KiB/s (slskd's unit); 0 means unlimited.
 */
export interface SlskdLimits {
  uploadSpeedLimit?: number;
  downloadSpeedLimit?: number;
  uploadSlots?: number;
  downloadSlots?: number;
}

/**
 * Nicotine+-style live status for the slskd extension page. Aggregates the
 * server connection, current up/down speeds, active/queued transfer counts,
 * configured limits, and share size. `enabled` reflects the plugin toggle;
 * `available` reflects whether a slskd client is actually reachable.
 */
export interface SlskdStatus {
  enabled: boolean;
  available: boolean;
  connection: SlskdServerState | null;
  speeds: SlskdSpeeds;
  counts: SlskdTransferCounts;
  limits: SlskdLimits;
  shares: SlskdShareStats;
  version?: string;
  uptimeSeconds?: number;
}

export interface SlskdShareDirectory {
  path: string;
  fileCount?: number;
}
