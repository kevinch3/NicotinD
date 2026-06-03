import { createLogger } from '@nicotind/core';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { YtdlpService, isBinaryAvailable } from './ytdlp.service.js';
import type { YtdlpConfig, SpotdlConfig, AcquireBackend } from './ytdlp.service.js';
import type { CompletedDownloadFile } from './path-inference.js';

const log = createLogger('acquire-watcher');

export interface AcquireWatcherOptions {
  db: Database;
  dataDir: string;
  ytdlp: YtdlpConfig;
  spotdl: SpotdlConfig;
  /** organizeBatch mutates file.relativePath in-place to the post-move path. */
  organizeBatch: (files: CompletedDownloadFile[]) => Promise<unknown>;
  scanIncremental: (relPaths: string[]) => Promise<void>;
}

export interface AcquireJob {
  id: string;
  backend: AcquireBackend;
  url: string;
  label: string | null;
  state: 'queued' | 'running' | 'done' | 'failed';
  progress: { done: number; total: number } | null;
  error: string | null;
  created_at: number;
}

interface AcquireJobRow {
  id: string;
  backend: string;
  url: string;
  label: string | null;
  state: string;
  progress: string | null;
  error: string | null;
  created_at: number;
}

export class AcquireWatcher {
  private ytdlpService: YtdlpService;
  private db: Database;

  constructor(private options: AcquireWatcherOptions) {
    this.db = options.db;
    this.ytdlpService = new YtdlpService({
      stagingBase: join(options.dataDir, 'staging', 'acquire'),
      db: options.db,
      ytdlp: options.ytdlp,
      spotdl: options.spotdl,
      onComplete: async (jobId, files) => {
        await this.handleComplete(jobId, files);
      },
      onFailed: (jobId, error) => {
        log.warn({ jobId, error }, 'Acquire job failed');
      },
    });
  }

  /**
   * Create and immediately start an acquire job. Returns the new job ID.
   * Rejects if the requested backend binary is not available.
   */
  async submit(url: string, backend: AcquireBackend, label?: string): Promise<string> {
    const binaryPath = backend === 'ytdlp'
      ? this.options.ytdlp.binaryPath
      : this.options.spotdl.binaryPath;

    if (!isBinaryAvailable(binaryPath)) {
      throw new Error(`${backend} binary not found at '${binaryPath}'`);
    }

    const id = crypto.randomUUID();
    this.db.run(
      `INSERT INTO acquire_jobs (id, backend, url, label, state) VALUES (?, ?, ?, ?, 'queued')`,
      [id, backend, url, label ?? null],
    );

    // Fire and forget — the YtdlpService drives state transitions.
    void this.ytdlpService.run(id, backend, url);
    return id;
  }

  cancel(jobId: string): boolean {
    return this.ytdlpService.cancel(jobId);
  }

  getJob(jobId: string): AcquireJob | null {
    const row = this.db
      .query<AcquireJobRow, [string]>(`SELECT * FROM acquire_jobs WHERE id = ?`)
      .get(jobId);
    return row ? this.mapRow(row) : null;
  }

  listJobs(limit = 50): AcquireJob[] {
    const rows = this.db
      .query<AcquireJobRow, [number]>(
        `SELECT * FROM acquire_jobs ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit);
    return rows.map((r) => this.mapRow(r));
  }

  /** Returns whether yt-dlp is available on the system. */
  isYtdlpAvailable(): boolean {
    return isBinaryAvailable(this.options.ytdlp.binaryPath);
  }

  /** Returns whether spotdl is available on the system. */
  isSpotdlAvailable(): boolean {
    return isBinaryAvailable(this.options.spotdl.binaryPath);
  }

  private async handleComplete(jobId: string, files: CompletedDownloadFile[]): Promise<void> {
    if (files.length === 0) {
      log.warn({ jobId }, 'Acquire job produced no audio files');
      return;
    }

    try {
      await this.options.organizeBatch(files);
      // organizeBatch mutates file.relativePath to the post-move path.
      const relPaths = files
        .map((f) => f.relativePath)
        .filter((p): p is string => Boolean(p));
      if (relPaths.length > 0) {
        await this.options.scanIncremental(relPaths);
      }
    } catch (err) {
      log.error({ jobId, err }, 'Organize/scan after acquire failed');
    }
  }

  private mapRow(row: AcquireJobRow): AcquireJob {
    let progress: { done: number; total: number } | null = null;
    if (row.progress) {
      try { progress = JSON.parse(row.progress); } catch { /* ignore */ }
    }
    return {
      id: row.id,
      backend: row.backend as AcquireBackend,
      url: row.url,
      label: row.label,
      state: row.state as AcquireJob['state'],
      progress,
      error: row.error,
      created_at: row.created_at,
    };
  }
}
