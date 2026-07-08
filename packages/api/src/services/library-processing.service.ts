import { EventEmitter } from 'node:events';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '@nicotind/core';
import type { Database } from 'bun:sqlite';
import type { Lidarr } from '@nicotind/lidarr-client';
import type { ProcessingSettings, ProcessingStatus, ProcessingTaskId } from '@nicotind/core';
import { getProcessingSettings } from './processing-settings.js';
import { isWithinWindow } from './processing-window.js';
import { maybeRefreshAutoPlaylists } from './auto-playlists.service.js';
import {
  ENRICHMENT_TASKS,
  createEnrichmentContext,
  type EnrichmentContext,
  type EnrichmentTask,
} from './enrichment/tasks.js';
import type { AudioFeaturesClient } from './audio-features-client.js';
import { captureProcessingFailure, type ProcessingFailureReport } from '../observability/sentry.js';
import { countSkippedFiles } from './enrichment/analysis-failures.js';

const log = createLogger('library-processing');

const STATUS_KEY = 'processing_status';
const MAX_SNIPPETS = 12;

/** Per-task failure tally accumulated over a run (task → count + one sample). */
type RunFailures = Map<ProcessingTaskId, { failed: number; sample: string | null }>;

/** Outcome of one bounded batch: items applied + per-task failures within it. */
interface BatchOutcome {
  applied: number;
  byTask: RunFailures;
}

/** Fold `src` into `dst`, summing counts and keeping the first sample per task. */
function mergeFailures(dst: RunFailures, src: RunFailures): void {
  for (const [task, agg] of src) {
    const prev = dst.get(task);
    if (prev) {
      prev.failed += agg.failed;
      if (prev.sample === null) prev.sample = agg.sample;
    } else {
      dst.set(task, { failed: agg.failed, sample: agg.sample });
    }
  }
}

export interface LibraryProcessingDeps {
  db: Database;
  lidarr: Lidarr | null;
  musicDir: string;
  dataDir: string;
  /** Spotify portrait lookup for the artist-image task, or null when unconfigured. */
  lookupArtistImageSpotify?: ((name: string) => Promise<string | null>) | null;
  /** Analysis-sidecar client for the audio-features task, or null when unconfigured. */
  audioFeaturesClient?: AudioFeaturesClient | null;
  /** Poll interval. Defaults to 60s. */
  intervalMs?: number;
  /** Injectable clock for window tests. */
  now?: () => Date;
  /** Injectable context factory for unit tests (fakes ffmpeg/Lidarr primitives). */
  contextFactory?: (settings: ProcessingSettings) => EnrichmentContext;
  /** Disable file logging (tests). Default true. */
  logToFile?: boolean;
  /** Failure sink for a run's aggregated errors. Defaults to the Sentry reporter
   *  (a no-op when Sentry is unconfigured); injectable so tests can assert on it. */
  reportFailure?: (report: ProcessingFailureReport) => void;
}

/**
 * Windowed library-processing scheduler. Runs enabled enrichment tasks
 * (ENRICHMENT_TASKS) over songs that still need them, only inside the configured
 * daily window. Resume is inherent: each task selects by its NULL predicate and
 * writes incrementally, so a restart mid-window continues exactly where it
 * stopped. Modeled on WatchlistService (start/stop interval + a busy guard).
 *
 * - `tick()` (periodic): one bounded batch per task when enabled AND in-window.
 *   The 60s interval + busy guard make in-window work effectively continuous and
 *   re-evaluate the window at each batch boundary.
 * - `runNow()` (admin override): drains batches ignoring the time window.
 * - `stop()`: halts the interval and any in-progress drain between tasks.
 */
export class LibraryProcessingService extends EventEmitter {
  private readonly db: Database;
  private readonly lidarr: Lidarr | null;
  private readonly musicDir: string;
  private readonly dataDir: string;
  private readonly lookupArtistImageSpotify: ((name: string) => Promise<string | null>) | null;
  private readonly audioFeaturesClient: AudioFeaturesClient | null;
  private readonly logPath: string;
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly contextFactory: (settings: ProcessingSettings) => EnrichmentContext;
  private readonly logToFile: boolean;
  private readonly reportFailure: (report: ProcessingFailureReport) => void;

  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private stopRequested = false;
  private status: ProcessingStatus;
  /** True until the first batch after construction: a restart is a session
   *  boundary. why: the restored tally belongs to the *previous* process (a
   *  deploy once carried 2300 pre-fix failures into a healthy run's display). */
  private freshProcess = true;

  constructor(deps: LibraryProcessingDeps) {
    super();
    this.db = deps.db;
    this.lidarr = deps.lidarr;
    this.musicDir = deps.musicDir;
    this.dataDir = deps.dataDir;
    this.lookupArtistImageSpotify = deps.lookupArtistImageSpotify ?? null;
    this.audioFeaturesClient = deps.audioFeaturesClient ?? null;
    this.logPath = join(deps.dataDir, 'library-processing.log');
    this.intervalMs = deps.intervalMs ?? 60_000;
    this.now = deps.now ?? (() => new Date());
    this.contextFactory =
      deps.contextFactory ??
      ((settings) =>
        createEnrichmentContext({
          musicDir: this.musicDir,
          coverCacheDir: join(this.dataDir, 'cover-cache'),
          lidarr: this.lidarr,
          concurrency: settings.concurrency,
          lookupArtistImageSpotify: this.lookupArtistImageSpotify,
          audioFeaturesClient: this.audioFeaturesClient,
        }));
    this.logToFile = deps.logToFile ?? true;
    this.reportFailure = deps.reportFailure ?? captureProcessingFailure;
    this.status = this.loadStatus();
  }

  start(): void {
    if (this.timer) return;
    log.info({ intervalMs: this.intervalMs }, 'Starting library-processing scheduler');
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Full shutdown: halt the interval and abort any in-progress run. */
  stop(): void {
    this.stopRequested = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Abort the current run (admin "Stop") without disabling the scheduler. */
  cancelRun(): void {
    this.stopRequested = true;
  }

  /** Settings + a freshly-computed status snapshot (pending counts, availability). */
  getState(): { settings: ProcessingSettings; status: ProcessingStatus } {
    const settings = getProcessingSettings(this.db);
    return { settings, status: this.snapshot(settings) };
  }

  /** Periodic tick: one batch when enabled and inside the window. */
  async tick(): Promise<void> {
    if (this.busy) return;
    const settings = getProcessingSettings(this.db);
    if (!settings.enabled) {
      this.publish(settings, 'disabled');
      return;
    }
    if (!isWithinWindow(this.now(), settings.window)) {
      this.publish(settings, 'outside-window');
      return;
    }
    await this.guarded(async () => {
      // Once per ISO week, inside the maintenance window, refresh the automated
      // recipe-driven shelves (idempotent; guarded by a library_sync_state marker).
      maybeRefreshAutoPlaylists(this.db, this.now().getTime());
      const batch = await this.processOneBatch(settings);
      this.flushFailures(batch.byTask);
      this.finishRun(settings);
    });
  }

  /** Admin override: drain all pending work now, ignoring the time window. */
  async runNow(): Promise<void> {
    await this.guarded(async () => {
      const runFailures: RunFailures = new Map();
      let first = true;
      for (;;) {
        if (this.stopRequested) break;
        const settings = getProcessingSettings(this.db);
        const tasks = this.runnableTasks(settings);
        const pending = tasks.reduce((sum, t) => sum + t.countPending(this.db), 0);
        if (pending === 0) break;
        const batch = await this.processOneBatch(settings, first);
        mergeFailures(runFailures, batch.byTask);
        first = false;
        // No progress (e.g. every remaining file missing / unresolvable) → stop
        // rather than spin forever.
        if (batch.applied === 0) break;
      }
      // One aggregated Sentry event per failing task for the whole drain, so a
      // broken decoder reports once (grouped) rather than per file or per batch.
      this.flushFailures(runFailures);
      this.finishRun(getProcessingSettings(this.db));
    });
  }

  // --- internals -----------------------------------------------------------

  private async guarded(fn: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    // Each run starts with a clear cancellation token; cancelRun()/stop() set it
    // mid-run to abort between tasks/batches.
    this.stopRequested = false;
    try {
      await fn();
    } catch (err) {
      log.error({ err }, 'library-processing run failed');
    } finally {
      this.busy = false;
    }
  }

  /** Runnable = per-task enabled AND available right now. */
  private runnableTasks(settings: ProcessingSettings): EnrichmentTask[] {
    const ctx = this.contextFactory(settings);
    return ENRICHMENT_TASKS.filter((t) => settings.tasks[t.id] && t.available(ctx) === true);
  }

  /** One bounded batch across each runnable task. */
  private async processOneBatch(
    settings: ProcessingSettings,
    fresh = false,
  ): Promise<BatchOutcome> {
    const ctx = this.contextFactory(settings);
    const tasks = this.runnableTasks(settings);
    const total = tasks.reduce((sum, t) => sum + t.countPending(this.db), 0);

    // A "run" spans one window session: tick batches inside the same window
    // continue the tally; the first batch after re-entering the window (or
    // re-enabling, a restart, or an explicit runNow) starts a fresh one. why:
    // the tally is persisted + reloaded, so without a session boundary a
    // long-resolved failure ("38 failed — ffmpeg…") stayed on the panel forever.
    const newRun =
      fresh ||
      this.freshProcess ||
      this.status.phase === 'outside-window' ||
      this.status.phase === 'disabled';
    this.freshProcess = false;
    this.status = {
      ...this.status,
      phase: 'running',
      startedAt:
        newRun || this.status.startedAt === null ? this.now().toISOString() : this.status.startedAt,
      processed: newRun ? 0 : this.status.processed,
      failed: newRun ? 0 : this.status.failed,
      lastError: newRun ? null : this.status.lastError,
      total,
    };
    this.emitStatus(settings);

    let appliedTotal = 0;
    const byTask: RunFailures = new Map();
    for (const task of tasks) {
      if (this.stopRequested) break;
      this.status = { ...this.status, currentTask: task.id };
      const result = await task.run(this.db, ctx, settings.batchSize);
      appliedTotal += result.applied;
      if (result.failed > 0) {
        mergeFailures(
          byTask,
          new Map([[task.id, { failed: result.failed, sample: result.errorSample }]]),
        );
      }
      this.status = {
        ...this.status,
        processed: this.status.processed + result.applied,
        failed: this.status.failed + result.failed,
        lastError: result.errorSample ?? this.status.lastError,
        lastItems: [...this.status.lastItems, ...result.labels].slice(-MAX_SNIPPETS),
      };
      for (const label of result.labels) this.writeLog(task.id, label);
      this.emitStatus(settings);
    }

    // Leave phase 'running' between batches; the run's terminal state is set once
    // by finishRun() so SSE clients see a single running→idle completion (not one
    // per batch during a multi-batch drain).
    this.status = { ...this.status, currentTask: null };
    this.emitStatus(settings);
    return { applied: appliedTotal, byTask };
  }

  /** Settle a finished run to idle and emit once, so clients get one completion. */
  private finishRun(settings: ProcessingSettings): void {
    this.status = { ...this.status, phase: 'idle', currentTask: null };
    this.emitStatus(settings);
  }

  /** Emit one aggregated failure report per task that failed during a run. */
  private flushFailures(byTask: RunFailures): void {
    for (const [task, agg] of byTask) {
      if (agg.failed <= 0) continue;
      log.warn(
        { task, failed: agg.failed, sample: agg.sample },
        'library-processing task failures',
      );
      this.reportFailure({ task, failed: agg.failed, applied: 0, sample: agg.sample });
    }
  }

  private snapshot(settings: ProcessingSettings): ProcessingStatus {
    const ctx = this.contextFactory(settings);
    const taskPending = {} as Record<ProcessingTaskId, number>;
    const availability = {} as Record<ProcessingTaskId, true | string>;
    for (const t of ENRICHMENT_TASKS) {
      taskPending[t.id] = t.countPending(this.db);
      availability[t.id] = t.available(ctx);
    }
    let phase = this.status.phase;
    if (!this.busy) {
      if (!settings.enabled) phase = 'disabled';
      else if (!isWithinWindow(this.now(), settings.window)) phase = 'outside-window';
      else phase = 'idle';
    }
    return {
      ...this.status,
      phase,
      taskPending,
      availability,
      skipped: countSkippedFiles(this.db),
      updatedAt: this.status.updatedAt,
    };
  }

  /** Persist + emit a snapshot for SSE subscribers. */
  private emitStatus(settings: ProcessingSettings): void {
    this.status = { ...this.status, updatedAt: this.now().toISOString() };
    this.persistStatus();
    this.emit('status', this.snapshot(settings));
  }

  /** Idle/disabled/outside-window publish without a batch. */
  private publish(settings: ProcessingSettings, phase: ProcessingStatus['phase']): void {
    this.status = { ...this.status, phase, currentTask: null };
    this.emitStatus(settings);
  }

  private writeLog(task: ProcessingTaskId, label: string): void {
    if (!this.logToFile) return;
    try {
      appendFileSync(this.logPath, `${this.now().toISOString()}\t${task}\t${label}\n`);
    } catch {
      /* best-effort logging */
    }
  }

  private persistStatus(): void {
    const persisted = {
      phase: this.status.phase,
      currentTask: this.status.currentTask,
      processed: this.status.processed,
      failed: this.status.failed,
      lastError: this.status.lastError,
      total: this.status.total,
      lastItems: this.status.lastItems,
      startedAt: this.status.startedAt,
      updatedAt: this.status.updatedAt,
    };
    this.db.run(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [STATUS_KEY, JSON.stringify(persisted)],
    );
  }

  private loadStatus(): ProcessingStatus {
    const base: ProcessingStatus = {
      phase: 'idle',
      currentTask: null,
      processed: 0,
      failed: 0,
      lastError: null,
      total: 0,
      lastItems: [],
      startedAt: null,
      updatedAt: null,
      taskPending: { bpm: 0, genre: 0, key: 0, 'artist-image': 0, energy: 0, 'audio-features': 0 },
      availability: {
        bpm: 'unknown',
        genre: 'unknown',
        key: 'unknown',
        'artist-image': 'unknown',
        energy: 'unknown',
        'audio-features': 'unknown',
      },
      skipped: 0,
    };
    const row = this.db
      .query<{ value: string }, [string]>('SELECT value FROM app_settings WHERE key = ?')
      .get(STATUS_KEY);
    if (!row) return base;
    try {
      return { ...base, ...(JSON.parse(row.value) as Partial<ProcessingStatus>) };
    } catch {
      return base;
    }
  }
}
