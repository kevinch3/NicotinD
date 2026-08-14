/**
 * Types for the admin "Import music from folder" flow (docs/import.md): a
 * server-side folder is run through the same organize → scan → quarantine
 * pipeline a download takes, chunk-wise, with copy-by-default semantics.
 */
import type { AcquireAlbumDestination, PipelineStage } from './acquire.js';

export type ImportJobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** Per-file outcome tallies for a finished (or in-flight) import job. */
export interface ImportJobSummary {
  /** Files that landed in the library. */
  imported: number;
  /** Files skipped because the library already had them (organizer dedupe). */
  skippedDuplicate: number;
  /** Files that landed in the `<dataDir>/unsorted` bucket (no artist/album metadata). */
  unsorted: number;
  failed: number;
  /** Move mode only: originals deleted after their content reached the library. */
  removedOriginals: number;
}

/** One source directory of an import job — the resume/progress unit. */
export interface ImportJobDir {
  sourceDir: string;
  fileCount: number;
  state: 'pending' | 'done' | 'failed';
  error: string | null;
}

export interface ImportJob {
  id: string;
  sourcePath: string;
  removeOriginals: boolean;
  state: ImportJobState;
  stage: PipelineStage | null;
  error: string | null;
  filesTotal: number;
  filesDone: number;
  bytesTotal: number;
  /** Source directory currently being imported, for progress display. */
  currentDir: string | null;
  summary: ImportJobSummary | null;
  destinationAlbums: AcquireAlbumDestination[];
  startedBy: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Typed rejection codes for an invalid import source path. */
export type ImportSourceErrorCode =
  | 'NOT_FOUND'
  | 'NOT_DIR'
  | 'INSIDE_LIBRARY'
  | 'CONTAINS_LIBRARY'
  | 'INSIDE_DATA_DIR'
  | 'CONTAINS_DATA_DIR';

/** Read-only dry-run report for a candidate import source (`POST /preview`). */
export interface ImportPreview {
  /** Canonical (realpath'd) source folder the walk ran over. */
  sourcePath: string;
  /** Directories containing at least one audio file — the album-folder estimate. */
  albumFolders: number;
  files: number;
  bytes: number;
  /** Non-audio files seen during the walk (skipped at import time). */
  unsupportedFiles: number;
  /** Symlinks are never followed; this counts how many were skipped. */
  skippedSymlinks: number;
  /** True when the walk hit IMPORT_MAX_FILES/IMPORT_MAX_DEPTH — submit refuses. */
  truncated: boolean;
  warnings: string[];
  disk: {
    freeMusicFs: number | null;
    freeStagingFs: number | null;
    requiredBytes: number;
    sufficient: boolean;
  };
}
