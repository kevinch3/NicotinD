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
 * The ONLY surface a plugin may use to affect the system. A plugin cannot reach
 * the library DB or the organizer directly — it produces files in the staging
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
   * Upsert one track's status into the job's per-track list, matched by
   * title. Unlike emitLabel this is NOT single-shot — it fires once per
   * track, many times over the life of a job.
   */
  emitTrack(jobId: string, track: { title: string; status: TrackStatus }): void;
  /** Plugin-scoped persistent storage. */
  storage: PluginStorage;
}
