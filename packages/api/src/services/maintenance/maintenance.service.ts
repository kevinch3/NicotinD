import { EventEmitter } from 'node:events';
import { createLogger } from '@nicotind/core';
import {
  buildMaintenanceTasks,
  type AnyMaintenanceTask,
  type MaintenanceDeps,
  type MaintenanceTaskId,
} from './tasks.js';

const log = createLogger('maintenance');

/** Snippet ring for the UI, mirroring the processor's MAX_SNIPPETS. */
const MAX_SNIPPETS = 12;

export type MaintenancePhase = 'idle' | 'running' | 'cancelling';
export type MaintenanceOutcome = 'completed' | 'cancelled' | 'failed';

export interface MaintenanceStatus {
  phase: MaintenancePhase;
  taskId: MaintenanceTaskId | null;
  label: string | null;
  /** Denominator fixed at pass start; 0 = the pass can't count ahead. */
  total: number;
  visited: number;
  /** Newest last, capped at MAX_SNIPPETS. */
  lastItems: string[];
  /** Per-task counters, keyed by the task's own names. */
  detail: Record<string, number>;
  dryRun: boolean;
  params: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastOutcome: MaintenanceOutcome | null;
  lastError: string | null;
  startedBy: string | null;
}

export type StartResult = 'started' | 'busy' | 'unavailable' | 'unknown-task';

function idleStatus(): MaintenanceStatus {
  return {
    phase: 'idle',
    taskId: null,
    label: null,
    total: 0,
    visited: 0,
    lastItems: [],
    detail: {},
    dryRun: false,
    params: null,
    startedAt: null,
    finishedAt: null,
    lastOutcome: null,
    lastError: null,
    startedBy: null,
  };
}

/**
 * Runs the operator-triggered whole-library passes as background jobs instead of
 * inside a request handler (issue #622).
 *
 * **Status is in-memory on purpose.** `LibraryProcessingService` persists because
 * its runs are unattended and recurring; `LibraryImportService` persists because
 * an import is genuinely resumable. Neither applies here: someone is watching,
 * and every item is an independent idempotent write, so "resume" is "press the
 * button again". Persisting would leave a `phase:'running'` row behind a crash
 * with no process under it — a permanently-running UI and a guard that never
 * releases. The tell that this is real: `LibraryProcessingService.snapshot()`
 * overrides its own persisted phase from `this.busy`, because even the service
 * that persists doesn't trust it across a restart. Durability lives in the audit
 * row instead.
 *
 * Must stay on the main thread: `optimizeAllAlbums` clears the cover
 * negative-cache, which is in-process module state — from a worker thread that
 * clear would land in the wrong process and covers would silently not appear.
 */
export class MaintenanceService extends EventEmitter {
  private readonly tasks: AnyMaintenanceTask[];
  private busy = false;
  private stopRequested = false;
  private status: MaintenanceStatus = idleStatus();

  private readonly now: () => Date;

  constructor(
    deps: MaintenanceDeps,
    /** `tasks` is a test seam; production always builds from `deps`. */
    opts: { now?: () => Date; tasks?: AnyMaintenanceTask[] } = {},
  ) {
    super();
    this.tasks = opts.tasks ?? buildMaintenanceTasks(deps);
    this.now = opts.now ?? (() => new Date());
  }

  getStatus(): MaintenanceStatus {
    return { ...this.status, lastItems: [...this.status.lastItems] };
  }

  /** Availability per task, for the admin UI to disable a button with a reason. */
  availability(): Record<MaintenanceTaskId, true | string> {
    const out = {} as Record<MaintenanceTaskId, true | string>;
    for (const t of this.tasks) out[t.id] = t.available();
    return out;
  }

  /**
   * Fire-and-forget. Returns synchronously so the route can answer 202/409/503
   * before any work happens — the busy answer has to be known now, which is why
   * this isn't the bare `void svc.runNow()` the processor route uses.
   */
  start(id: string, q: URLSearchParams, startedBy?: string | null): StartResult {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return 'unknown-task';
    if (task.available() !== true) return 'unavailable';
    if (this.busy) return 'busy';

    const params = task.parseParams(q);
    const { summary, dryRun } = task.describe(params);
    this.busy = true;
    // Cleared at run start, never at cancel: a cancel arriving between runs must
    // not disarm the next one.
    this.stopRequested = false;
    this.status = {
      ...idleStatus(),
      phase: 'running',
      taskId: task.id,
      label: task.label,
      dryRun,
      params: summary,
      startedAt: this.now().toISOString(),
      startedBy: startedBy ?? null,
    };
    this.emitStatus();
    void this.run(task, params);
    return 'started';
  }

  /** Abort the current pass. False when nothing is running. */
  cancel(): boolean {
    if (!this.busy) return false;
    this.stopRequested = true;
    this.status = { ...this.status, phase: 'cancelling' };
    this.emitStatus();
    return true;
  }

  /** Shutdown hook — same as cancel, named for the lifecycle call site. */
  stop(): void {
    this.stopRequested = true;
  }

  private async run(task: AnyMaintenanceTask, params: unknown): Promise<void> {
    let outcome: MaintenanceOutcome = 'completed';
    try {
      const result = await task.run(
        {
          shouldStop: () => this.stopRequested,
          onProgress: (p) => {
            this.status = {
              ...this.status,
              total: p.total,
              visited: p.visited,
              lastItems: [...this.status.lastItems, p.label].slice(-MAX_SNIPPETS),
            };
            this.emitStatus();
          },
        },
        params,
      );
      this.status = {
        ...this.status,
        detail: result.detail,
        lastError: result.errorSample,
      };
      if (this.stopRequested) outcome = 'cancelled';
    } catch (err) {
      outcome = 'failed';
      const message = err instanceof Error ? err.message : String(err);
      this.status = { ...this.status, lastError: message };
      log.error({ err, task: task.id }, 'maintenance pass failed');
    } finally {
      this.busy = false;
      this.stopRequested = false;
      this.status = {
        ...this.status,
        phase: 'idle',
        finishedAt: this.now().toISOString(),
        lastOutcome: outcome,
      };
      this.emitStatus();
      log.info({ task: task.id, outcome, ...this.status.detail }, 'maintenance pass finished');
    }
  }

  private emitStatus(): void {
    this.emit('status', this.getStatus());
  }
}
