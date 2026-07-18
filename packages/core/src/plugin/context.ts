import type { Logger } from '../utils/logger.js';
import type { TrackStatus } from '../types/acquire.js';

/** Plugin-scoped persistent key/value store (sqlite-backed by the host). */
export interface PluginStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export interface PluginProgress {
  done: number;
  total: number;
}

/**
 * One track's status, as the plugin emits it. `path` is the file basename the
 * plugin is about to write (or just wrote) in staging — recorded so the
 * post-ingest playlist step can resolve the post-scan library_song without
 * title collisions (two tracks with identical titles in the same playlist
 * still map to distinct song ids via their file basenames). Optional for
 * backwards-compat with older plugins; the post-ingest step falls back to a
 * title-only match within the job's `acquisitions` rows when path is missing.
 */
export interface PluginTrackEvent {
  title: string;
  status: TrackStatus;
  path?: string;
}

/**
 * The ONLY surface a plugin may use to affect the system. A plugin cannot reach
 * the library DB or the organizer directly — it produces files in a staging
 * dir and emits progress; the host owns ingest (organize → scan → enrich). This
 * boundary is the decoupling guarantee and the safety story.
 */
export interface PluginHostContext {
  /** Scoped logger (named after the plugin). */
  logger: Logger;
  /** Resolved + schema-validated config/secrets for this plugin. */
  config: Record<string, unknown>;
  /** Allocate (mkdir -p) and return a staging dir the host will ingest + clean. */
  allocStagingDir(jobId: string): string;
  /** Report progress for an in-flight job to the host's job tables. */
  emitProgress(jobId: string, progress: PluginProgress): void;
  /** Update the human-readable label for an in-flight job (e.g. playlist title). */
  emitLabel(jobId: string, label: string): void;
  /**
   * Upsert one track's status into the job's per-track list. Fires once per
   * track, many times over the life of a job (unlike the single-shot label).
   * Optional `path` disambiguates title collisions for the post-ingest
   * playlist step — see `PluginTrackEvent.path`.
   */
  emitTrack(jobId: string, track: PluginTrackEvent): void;
  /** Plugin-scoped persistent storage. */
  storage: PluginStorage;
}
