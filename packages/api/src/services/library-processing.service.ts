import { EventEmitter } from 'node:events';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '@nicotind/core';
import type { Database } from 'bun:sqlite';
import type { Lidarr } from '@nicotind/lidarr-client';
import type { ProcessingSettings, ProcessingStatus, ProcessingTaskId } from '@nicotind/core';
import { getProcessingSettings } from './processing-settings.js';
import { isWithinWindow } from './processing-window.js';
import {
  ENRICHMENT_TASKS,
  createEnrichmentContext,
  type EnrichmentContext,
  type EnrichmentTask,
} from './enrichment/tasks.js';

const log = createLogger('library-processing');

const STATUS_KEY = 'processing_status';
const MAX_SNIPPETS = 12;

export interface LibraryProcessingDeps {
  db: Database;
  lidarr: Lidarr | null;
  musicDir: string;
  dataDir: string;
  /** Poll interval. Defaults to 60s. */
  intervalMs?: number;
  /** Injectable clock for window tests. */
  now?: () => Date;
  /** Injectable context factory for unit tests (fakes ffmpeg/Lidarr primitives). */
  contextFactory?: (settings: ProcessingSettings) => EnrichmentContext;
  /** Disable file logging (tests). Default true. */
  logToFile?: boolean;
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
  private readonly logPath: string;
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly contextFactory: (settings: ProcessingSettings) => EnrichmentContext;
  private readonly logToFile: boolean;

  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private stopRequested = false;
  private status: ProcessingStatus;

  constructor(deps: LibraryProcessingDeps) {
    super();
    this.db = deps.db;
    this.lidarr = deps.lidarr;
    this.musicDir = deps.musicDir;
    this.logPath = join(deps.dataDir, 'library-processing.log');
    this.intervalMs = deps.intervalMs ?? 60_000;
    this.now = deps.now ?? (() => new Date());
    this.contextFactory =
      deps.contextFactory ??
      ((settings) =>
        createEnrichmentContext({
          musicDir: this.musicDir,
          lidarr: this.lidarr,
          concurrency: settings.concurrency,
        }));
    this.logToFile = deps.logToFile ?? true;
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
      await this.processOneBatch(settings);
    });
  }

  /** Admin override: drain all pending work now, ignoring the time window. */
  async runNow(): Promise<void> {
    await this.guarded(async () => {
      let first = true;
      for (;;) {
        if (this.stopRequested) break;
        const settings = getProcessingSettings(this.db);
        const tasks = this.runnableTasks(settings);
        const pending = tasks.reduce((sum, t) => sum + t.countPending(this.db), 0);
        if (pending === 0) break;
        const applied = await this.processOneBatch(settings, first);
        first = false;
        // No progress (e.g. every remaining file missing / unresolvable) → stop
        // rather than spin forever.
        if (applied === 0) break;
      }
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

  /** One bounded batch across each runnable task. Returns total items applied. */
  private async processOneBatch(settings: ProcessingSettings, fresh = false): Promise<number> {
    const ctx = this.contextFactory(settings);
    const tasks = this.runnableTasks(settings);
    const total = tasks.reduce((sum, t) => sum + t.countPending(this.db), 0);

    const startedAt =
      fresh || this.status.phase !== 'running' ? this.now().toISOString() : this.status.startedAt;
    this.status = {
      ...this.status,
      phase: 'running',
      startedAt,
      processed: fresh ? 0 : this.status.processed,
      total,
    };
    this.emitStatus(settings);

    let appliedTotal = 0;
    for (const task of tasks) {
      if (this.stopRequested) break;
      this.status = { ...this.status, currentTask: task.id };
      const result = await task.run(this.db, ctx, settings.batchSize);
      appliedTotal += result.applied;
      this.status = {
        ...this.status,
        processed: this.status.processed + result.applied,
        lastItems: [...this.status.lastItems, ...result.labels].slice(-MAX_SNIPPETS),
      };
      for (const label of result.labels) this.writeLog(task.id, label);
      this.emitStatus(settings);
    }

    this.status = { ...this.status, phase: 'idle', currentTask: null };
    this.emitStatus(settings);
    return appliedTotal;
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
      total: 0,
      lastItems: [],
      startedAt: null,
      updatedAt: null,
      taskPending: { bpm: 0, genre: 0, key: 0 },
      availability: { bpm: 'unknown', genre: 'unknown', key: 'unknown' },
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
