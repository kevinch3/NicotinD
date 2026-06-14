import { rmSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { createLogger } from '@nicotind/core';
import type { AcquireJob, AcquisitionMethod, Plugin } from '@nicotind/core';
import type { Database } from 'bun:sqlite';
import type { PluginRegistry } from './plugins/registry.js';
import { pluginStagingDir } from './plugins/host-context.js';
import type { CompletedDownloadFile } from './path-inference.js';
import { recordAcquisition } from './acquisition-store.js';

/** Map an acquisition plugin id to an AcquisitionMethod; unknown ids → 'unknown'. */
function methodForBackend(backend: string): AcquisitionMethod {
  return backend === 'ytdlp' || backend === 'spotdl' || backend === 'archive'
    ? backend
    : 'unknown';
}

const log = createLogger('acquire-watcher');

export class NoAcquisitionPluginError extends Error {
  constructor(url: string) {
    super(`No enabled acquisition plugin can handle "${url}"`);
    this.name = 'NoAcquisitionPluginError';
  }
}

export class PluginUnavailableError extends Error {
  constructor(pluginId: string) {
    super(`Acquisition plugin "${pluginId}" is enabled but not available (binary missing?)`);
    this.name = 'PluginUnavailableError';
  }
}

export interface AcquireWatcherOptions {
  db: Database;
  /** Expanded (no `~`) data dir — staging lives under it. */
  dataDir: string;
  /** Resolves which enabled plugin handles a URL + drives its resolve capability. */
  registry: PluginRegistry;
  /** organizeBatch mutates file.relativePath in-place to the post-move path. */
  organizeBatch: (files: CompletedDownloadFile[]) => Promise<unknown>;
  scanIncremental: (relPaths: string[]) => Promise<void>;
  /**
   * Optional best-effort enrichment of loose singles/EPs (Lidarr/MusicBrainz
   * release type + artwork) run after the incremental scan, then a reclassify.
   */
  enrichSingles?: (relPaths: string[]) => Promise<void>;
}

export type { AcquireJob } from '@nicotind/core';

interface AcquireJobRow {
  id: string;
  backend: string;
  url: string;
  label: string | null;
  state: string;
  stage: string | null;
  storage_path: string | null;
  progress: string | null;
  error: string | null;
  created_at: number;
}

/**
 * Host-side driver for URL-based acquisition. It owns the `acquire_jobs` records
 * and the post-download ingest (organize → scan → enrich); the actual download
 * is delegated to whichever enabled `resolve`-capable plugin handles the URL
 * (`registry.getEnabledForUrl`). The plugin stages files + emits progress; this
 * class never knows about yt-dlp/spotdl specifics.
 */
export class AcquireWatcher {
  private db: Database;
  /** jobId → the plugin running it, for cancel. */
  private active = new Map<string, Plugin>();

  constructor(private options: AcquireWatcherOptions) {
    this.db = options.db;
    // Prune done/failed jobs older than 7 days so the list stays bounded.
    this.db.run(
      `DELETE FROM acquire_jobs WHERE state IN ('done', 'failed') AND created_at < unixepoch() - 604800`,
    );
  }

  /** Plugin that would handle this URL right now (enabled + canHandle), if any. */
  pluginForUrl(url: string): Plugin | undefined {
    return this.options.registry.getEnabledForUrl(url);
  }

  /**
   * Create + start an acquire job. Throws `NoAcquisitionPluginError` when no
   * enabled plugin handles the URL, or `PluginUnavailableError` when the chosen
   * plugin's binary is missing.
   */
  async submit(url: string, label?: string): Promise<string> {
    const plugin = this.pluginForUrl(url);
    if (!plugin?.resolve) throw new NoAcquisitionPluginError(url);
    if (!(await plugin.isAvailable())) throw new PluginUnavailableError(plugin.manifest.id);

    const id = crypto.randomUUID();
    this.db.run(
      `INSERT INTO acquire_jobs (id, backend, url, label, state, stage) VALUES (?, ?, ?, ?, 'queued', 'queued')`,
      [id, plugin.manifest.id, url, label ?? null],
    );

    void this.run(plugin, id, url);
    return id;
  }

  private async run(plugin: Plugin, id: string, url: string): Promise<void> {
    this.active.set(id, plugin);
    this.updateState(id, 'running');
    this.setStage(id, 'downloading');
    log.info({ id, plugin: plugin.manifest.id, url }, 'Starting acquire job');
    try {
      const paths = await plugin.resolve!.resolve(url, id);
      // With --ignore-errors a partly-unavailable playlist still resolves; only
      // a download that produced nothing at all is a real failure.
      if (paths.length === 0) {
        this.updateState(id, 'failed', 'Download produced no audio files');
        this.setStage(id, 'error');
        return;
      }
      this.updateState(id, 'done');
      await this.ingest(id, plugin.manifest.id, url, paths);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ id, err: msg }, 'Acquire job failed');
      this.updateState(id, 'failed', msg);
      this.setStage(id, 'error');
    } finally {
      this.active.delete(id);
      try {
        rmSync(pluginStagingDir(this.options.dataDir, plugin.manifest.id, id), {
          recursive: true,
          force: true,
        });
      } catch {
        // Non-fatal; files have already been moved by organizeBatch.
      }
    }
  }

  private async ingest(
    id: string,
    pluginId: string,
    url: string,
    paths: string[],
  ): Promise<void> {
    if (paths.length === 0) {
      log.warn({ id }, 'Acquire job produced no audio files');
      return;
    }
    const stagingDir = pluginStagingDir(this.options.dataDir, pluginId, id);
    // Map staged absolute paths to the organizer's contract: `directory` is the
    // path relative to the job staging dir so LibraryOrganizer can infer
    // artist/album from the downloader's output template.
    const files: CompletedDownloadFile[] = paths.map((p) => ({
      username: `acquire:${id}`,
      directory: relative(stagingDir, dirname(p)) || '.',
      filename: p,
    }));
    try {
      this.setStage(id, 'organizing');
      await this.options.organizeBatch(files);
      const relPaths = files.map((f) => f.relativePath).filter((p): p is string => Boolean(p));
      // Record acquisition provenance + the landing dir, keyed on the final path.
      const acquiredAt = Date.now();
      const method = methodForBackend(pluginId);
      for (const relPath of relPaths) {
        recordAcquisition(this.db, {
          relativePath: relPath,
          method,
          sourceRef: url,
          stage: 'done',
          startedAt: acquiredAt,
          completedAt: acquiredAt,
        });
      }
      if (relPaths.length > 0) {
        this.setStoragePath(id, dirname(relPaths[0]!));
        this.setStage(id, 'scanning');
        await this.options.scanIncremental(relPaths);
        if (this.options.enrichSingles) await this.options.enrichSingles(relPaths);
      }
      this.setStage(id, 'done');
    } catch (err) {
      log.error({ id, err }, 'Organize/scan after acquire failed');
    }
  }

  cancel(jobId: string): boolean {
    const plugin = this.active.get(jobId);
    return plugin?.resolve?.cancel?.(jobId) ?? false;
  }

  /** Remove a done or failed job from the DB. Returns true if a row was deleted. */
  deleteJob(jobId: string): boolean {
    const result = this.db.run(
      `DELETE FROM acquire_jobs WHERE id = ? AND state IN ('done', 'failed')`,
      [jobId],
    );
    return result.changes > 0;
  }

  /** Re-submit a failed (or done) job using the same URL. */
  async retryJob(jobId: string): Promise<string | null> {
    const row = this.db
      .query<AcquireJobRow, [string]>(`SELECT * FROM acquire_jobs WHERE id = ?`)
      .get(jobId);
    if (!row) return null;
    const newId = await this.submit(row.url, row.label ?? undefined);
    this.db.run(`DELETE FROM acquire_jobs WHERE id = ?`, [jobId]);
    return newId;
  }

  getJob(jobId: string): AcquireJob | null {
    const row = this.db
      .query<AcquireJobRow, [string]>(`SELECT * FROM acquire_jobs WHERE id = ?`)
      .get(jobId);
    return row ? this.mapRow(row) : null;
  }

  listJobs(limit = 50): AcquireJob[] {
    const rows = this.db
      .query<AcquireJobRow, [number]>(`SELECT * FROM acquire_jobs ORDER BY created_at DESC LIMIT ?`)
      .all(limit);
    return rows.map((r) => this.mapRow(r));
  }

  updateLabel(jobId: string, label: string): void {
    try {
      this.db.run(`UPDATE acquire_jobs SET label = ? WHERE id = ?`, [label, jobId]);
    } catch (err) {
      log.warn({ jobId, err }, 'Failed to update acquire_jobs label');
    }
  }

  private updateState(jobId: string, state: string, error?: string): void {
    try {
      this.db.run(`UPDATE acquire_jobs SET state = ?, error = ? WHERE id = ?`, [
        state,
        error ?? null,
        jobId,
      ]);
    } catch (err) {
      log.warn({ jobId, err }, 'Failed to update acquire_jobs state');
    }
  }

  /** Set the fine-grained pipeline stage (queued → downloading → … → done/error). */
  private setStage(jobId: string, stage: string): void {
    try {
      this.db.run(`UPDATE acquire_jobs SET stage = ? WHERE id = ?`, [stage, jobId]);
    } catch (err) {
      log.warn({ jobId, err }, 'Failed to update acquire_jobs stage');
    }
  }

  /** Record the canonical album dir the job's files landed in. */
  private setStoragePath(jobId: string, storagePath: string): void {
    try {
      this.db.run(`UPDATE acquire_jobs SET storage_path = ? WHERE id = ?`, [storagePath, jobId]);
    } catch (err) {
      log.warn({ jobId, err }, 'Failed to update acquire_jobs storage_path');
    }
  }

  private mapRow(row: AcquireJobRow): AcquireJob {
    let progress: { done: number; total: number } | null = null;
    if (row.progress) {
      try {
        progress = JSON.parse(row.progress);
      } catch {
        /* ignore */
      }
    }
    return {
      id: row.id,
      backend: row.backend as AcquireJob['backend'],
      url: row.url,
      label: row.label,
      state: row.state as AcquireJob['state'],
      stage: (row.stage as AcquireJob['stage']) ?? null,
      storage_path: row.storage_path ?? null,
      progress,
      error: row.error,
      created_at: row.created_at,
    };
  }
}
