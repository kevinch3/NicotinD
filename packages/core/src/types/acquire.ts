/** The known URL-acquisition backends. */
export type AcquireBackend = 'ytdlp' | 'spotdl';
export type AcquireJobState = 'queued' | 'running' | 'done' | 'failed';

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
  | 'done'
  | 'error';

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
  progress: { done: number; total: number } | null;
  error: string | null;
  created_at: number;
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
