/** The known URL-acquisition backends. */
export type AcquireBackend = 'ytdlp' | 'spotdl';
export type AcquireJobState = 'queued' | 'running' | 'done' | 'failed';

/** Per-track download state within an acquire job, keyed by title. */
export type TrackStatus = 'pending' | 'downloading' | 'done' | 'skipped' | 'failed';

/**
 * Where a track came from. Mirrors the acquisition plugin id for URL jobs
 * (`ytdlp` / `spotdl` / `archive`), plus `slskd` for Soulseek and `unknown`
 * for rows the best-effort backfill couldn't resolve.
 */
export type AcquisitionMethod = 'slskd' | 'ytdlp' | 'spotdl' | 'archive' | 'unknown';

/**
 * Named stages of the acquisition pipeline, surfaced to the user so a download
 * is transparent end-to-end. Applies to both Soulseek and URL acquisition;
 * `done`/`error` are terminal.
 */
export type PipelineStage =
  | 'queued'
  | 'downloading'
  | 'organizing'
  | 'scanning'
  /** Scanned into the library but still quarantined behind enrichment gates. */
  | 'processing'
  | 'done'
  | 'error';

/**
 * A single destination album an acquire job's files landed in — artist,
 * title, and the deterministic library album id, derived from the
 * `<Artist>/<Album>` tail of an organized path (see `deriveAcquireAlbum`).
 */
export interface AcquireAlbumDestination {
  albumArtist: string;
  albumTitle: string;
  albumId: string;
}

/** How a unified acquisition job was initiated. */
export type AcquisitionJobKind = 'album-hunt' | 'auto-acquire' | 'direct' | 'track-search' | 'url';

/**
 * Read model of one unified acquisition job (`GET /api/downloads/jobs`).
 * Every download — slskd hunts, fallback recoveries, direct grabs, per-track
 * searches, URL acquires — is wrapped in one of these; the transfer↔job
 * linkage is stored at enqueue time (see docs/acquisition-jobs.md).
 */
export interface AcquisitionJobView {
  id: string;
  kind: AcquisitionJobKind;
  method: string;
  state: 'active' | 'done' | 'failed' | 'superseded';
  stage: PipelineStage;
  artistName: string | null;
  albumTitle: string | null;
  lidarrAlbumId: number | null;
  sourceRef: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  /** Destination library album id, for deep-linking. */
  albumId: string | null;
  /**
   * Per-item tallies. `delivered` = items on disk (completed/organized/
   * scanned); `unavailable` = tracks the fallback gave up on — a job with
   * some renders as an honest partial ("11 of 13 · 2 unavailable").
   */
  progress: { expected: number; delivered: number; unavailable: number; failed: number };
  /**
   * Per-track status, uniform across every acquisition backend (slskd hunts
   * expose this from `acquisition_job_items`; URL acquires expose it from
   * `acquire_jobs.tracks_json` — see `AcquireJob.tracks`).
   */
  items: { title: string; status: TrackStatus }[];
  /**
   * Dominant bitrate (kbps) of the job's files. For slskd hunts, this is the
   * enqueue-time bitrate (what the peer advertised); it upgrades to the
   * library-scanned value once the scan lands (see downloads.ts enrichWithBitrate
   * + library_songs join). For URL acquires, this mirrors `AcquireJob.bitRate`.
   * Optional: undefined when no quality info is available.
   */
  bitRate?: number;
  /**
   * Codec/format string ("FLAC", "MP3", "opus", …). Sourced from `detectFormat`
   * for slskd hunts (extension + bitrate heuristic) and from ffprobe for URL
   * acquires. Optional: undefined when no quality info is available.
   */
  audioFormat?: string;
}

export interface AcquireJob {
  id: string;
  /** Id of the acquisition plugin that ran the job (e.g. 'ytdlp', 'spotdl'). */
  backend: string;
  url: string;
  label: string | null;
  state: AcquireJobState;
  /** Fine-grained pipeline stage (queued → downloading → organizing → scanning → done). */
  stage: PipelineStage | null;
  /** Canonical album dir the job's files were organized into, once known. */
  storage_path: string | null;
  /** Destination library album id (derived from storage_path), for deep-linking. */
  albumId: string | null;
  /** Destination album artist, derived from storage_path. */
  albumArtist: string | null;
  /** Destination album title, derived from storage_path. */
  albumTitle: string | null;
  /**
   * The full, distinct set of destination albums the job's files landed in.
   * Always present (may be empty pre-ingest / on rows predating this field).
   * `albumId`/`albumArtist`/`albumTitle` above are only populated when this
   * has exactly one entry — the single-album convenience case.
   */
  destinationAlbums: AcquireAlbumDestination[];
  progress: { done: number; total: number } | null;
  /**
   * Per-track download state, in playlist order where known. Appended-to /
   * status-updated in place by title match as tracks are discovered
   * (spotdl/yt-dlp) or known upfront (archive). Always present (empty for
   * pre-migration rows or jobs without per-track granularity).
   */
  tracks: { title: string; status: TrackStatus }[];
  /**
   * True when the URL was classified as a playlist (Spotify playlist,
   * YouTube playlist, archive.org item with `as=playlist`). When true, the
   * post-ingest step materializes a per-user native playlist from the
   * `acquire_job_tracks` rows. Always present (defaults to false for
   * pre-feature jobs). See docs/playlist-from-acquisition.md.
   */
  isPlaylist: boolean;
  /**
   * Set after the generated playlist is created; lets the Downloads card link
   * straight to the playlist detail page. Null while the post-ingest step
   * hasn't run yet, when the URL wasn't a playlist, or when no tracks
   * landed. ON DELETE SET NULL on the FK so a user who removes the playlist
   * doesn't leave a dangling reference.
   */
  playlistId: string | null;
  error: string | null;
  created_at: number;
  /**
   * Dominant bitrate (kbps) of the landed files, populated by AcquireWatcher
   * via ffprobe after the lossless→opus transcode so the value matches what
   * landed in the library. Powers the "· 320 kbps" chip on the download card.
   * Optional: null while the job is still in-flight, and for pre-feature rows.
   */
  bitRate?: number | null;
  /**
   * Codec/format string for the landed files, e.g. "mp3", "opus", "flac". Sourced
   * from `ffprobe -show_entries stream=codec_name`. Always shown alongside the
   * bitrate for lossless codecs (flac), optional for lossy.
   */
  audioFormat?: string | null;
}

/** Acquisition provenance for a single library song (see `acquisitions` table). */
export interface SongAcquisition {
  method: AcquisitionMethod;
  /** slskd peer username or the acquire URL, depending on method. */
  sourceRef: string | null;
  /** Unix ms when the download completed. */
  acquiredAt: number | null;
  /** Final on-disk path relative to the music dir. */
  storagePath: string;
}
