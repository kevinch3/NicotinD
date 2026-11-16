import { randomUUID } from 'node:crypto';
import type { HuntLane, HuntScheduler, HuntTicket } from './hunt-scheduler.js';

/**
 * Interactive album hunts, one at a time per source (#1625).
 *
 * The source runs one hunt at a time anyway (the slskd addon's `SearchLanes`),
 * so a burst of clicks is a queue whether we model it or not. Before this, each
 * click held an HTTP request with one 55 s budget covering *queue wait plus
 * search*: on kpc a base-only hunt holds the lanes ~11 s, so the 5th hunt of a
 * burst timed out having never searched (26 of 70 hunts in 13 h). Here the wait
 * is free — the caller gets a hunt id and polls — and only the running hunt
 * spends a budget. See docs/album-hunt.md "Interactive hunts queue in core".
 */
export type HuntStatus<R> =
  | { state: 'queued'; position: number; etaMs: number }
  | { state: 'searching'; elapsedMs: number; etaMs: number }
  | { state: 'done'; result: R }
  | { state: 'failed'; error: string; timedOut: boolean };

export class HuntQueueFullError extends Error {
  constructor(max: number) {
    super(`The hunt queue is full (${max} waiting) — try again shortly.`);
    this.name = 'HuntQueueFullError';
  }
}

interface Entry<R> {
  id: string;
  key: string;
  run: (id: string) => Promise<R>;
  state: 'queued' | 'searching' | 'done' | 'failed';
  startedAt: number | null;
  finishedAt: number | null;
  result?: R;
  error?: string;
  timedOut?: boolean;
  settled: Promise<void>;
  settle: () => void;
}

export interface HuntQueueOptions {
  now?: () => number;
  /** The estimate before any hunt has finished — a base-only hunt measured on kpc. */
  initialMeanMs?: number;
  /** How long a finished hunt stays readable for its poller. */
  retainMs?: number;
  /** Waiting hunts beyond this are refused rather than queued. */
  maxQueued?: number;
  /** Tells a timeout from any other failure, so the caller can say which. */
  isTimeout?: (err: unknown) => boolean;
  /**
   * The source's shared gate and this queue's lane in it (#1945). With one, a
   * hunt waits for its turn across every queue before it searches; without
   * one the queue runs alone, as it did.
   */
  scheduler?: HuntScheduler;
  lane?: HuntLane;
}

/** How many recent durations the estimate averages. */
const DURATION_WINDOW = 10;

export class HuntQueue<R> {
  private readonly entries = new Map<string, Entry<R>>();
  private readonly waiting: string[] = [];
  private active: string | null = null;
  private readonly durations: number[] = [];
  private readonly now: () => number;
  private readonly initialMeanMs: number;
  private readonly retainMs: number;
  private readonly maxQueued: number;
  private readonly isTimeout: (err: unknown) => boolean;
  private readonly scheduler: HuntScheduler | null;
  private readonly lane: HuntLane;
  /** The head hunt's place at the shared gate, while it waits there. */
  private gate: HuntTicket | null = null;

  constructor(opts: HuntQueueOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.initialMeanMs = opts.initialMeanMs ?? 12_000;
    this.retainMs = opts.retainMs ?? 5 * 60_000;
    this.maxQueued = opts.maxQueued ?? 50;
    this.isTimeout = opts.isTimeout ?? (() => false);
    this.scheduler = opts.scheduler ?? null;
    this.lane = opts.lane ?? 'get';
  }

  /**
   * Queue a hunt for `key` (one album). A hunt for the same key that is still
   * waiting or running is joined instead — one album, one search.
   */
  enqueue(key: string, run: (id: string) => Promise<R>): { id: string; joined: boolean } {
    this.evict();
    for (const e of this.entries.values()) {
      if (e.key === key && (e.state === 'queued' || e.state === 'searching')) {
        return { id: e.id, joined: true };
      }
    }
    if (this.waiting.length >= this.maxQueued) throw new HuntQueueFullError(this.maxQueued);
    let settle!: () => void;
    const settled = new Promise<void>((r) => (settle = r));
    const id = randomUUID();
    this.entries.set(id, {
      id,
      key,
      run,
      state: 'queued',
      startedAt: null,
      finishedAt: null,
      settled,
      settle,
    });
    this.waiting.push(id);
    this.pump();
    return { id, joined: false };
  }

  status(id: string): HuntStatus<R> | null {
    this.evict();
    const e = this.entries.get(id);
    if (!e) return null;
    const mean = this.meanMs();
    const activeLeft = this.activeRemainingMs(mean);
    switch (e.state) {
      case 'queued': {
        // The head hunt may be waiting at the shared gate: it has left
        // `waiting` and is not searching yet. Other queues' searches ahead of
        // this queue's head count toward every position behind it too.
        const gated = this.active === id;
        const at = gated ? 0 : this.waiting.indexOf(id);
        const elsewhere = this.gate?.ahead() ?? 0;
        const ownAhead = gated ? 0 : at + (this.active ? 1 : 0);
        return {
          state: 'queued',
          position: ownAhead + elsewhere,
          etaMs: (gated ? 0 : activeLeft + at * mean) + elsewhere * mean,
        };
      }
      case 'searching':
        return {
          state: 'searching',
          elapsedMs: this.now() - (e.startedAt ?? this.now()),
          etaMs: activeLeft,
        };
      case 'done':
        return { state: 'done', result: e.result as R };
      case 'failed':
        return { state: 'failed', error: e.error ?? 'hunt failed', timedOut: e.timedOut ?? false };
    }
  }

  /**
   * The live (waiting or running) hunt for `key`, for a caller that knows the key rather than the
   * entry id: a Get's job row, whose Activity card shows its place in line (#1938).
   */
  statusOfKey(key: string): HuntStatus<R> | null {
    for (const [id, e] of this.entries) {
      if (e.key === key && (e.state === 'queued' || e.state === 'searching'))
        return this.status(id);
    }
    return null;
  }

  /** Resolves with the hunt's result once it ran; rejects with its failure. */
  async wait(id: string): Promise<R> {
    const e = this.entries.get(id);
    if (!e) throw new Error('Unknown hunt');
    await e.settled;
    if (e.state === 'failed') throw new Error(e.error ?? 'hunt failed');
    return e.result as R;
  }

  /** Remove a hunt that has not started. A running hunt cannot be recalled. */
  cancel(id: string): boolean {
    const at = this.waiting.indexOf(id);
    if (at < 0) {
      // The head hunt, still waiting at the shared gate: it can be recalled too.
      if (this.active !== id || !this.gate?.cancel()) return false;
      this.gate = null;
      this.active = null;
      const head = this.entries.get(id);
      this.entries.delete(id);
      head?.settle();
      this.pump();
      return true;
    }
    this.waiting.splice(at, 1);
    const e = this.entries.get(id);
    this.entries.delete(id);
    e?.settle();
    return true;
  }

  private pump(): void {
    if (this.active) return;
    const id = this.waiting.shift();
    if (!id) return;
    const e = this.entries.get(id);
    if (!e) return this.pump();
    this.active = id;
    if (!this.scheduler) return this.start(e, () => {});
    // Its turn in this queue; now its turn at the source, across every queue.
    const ticket = this.scheduler.request(this.lane);
    this.gate = ticket;
    void ticket.granted.then((release) => {
      if (this.gate !== ticket) return release();
      this.gate = null;
      this.start(e, release);
    });
  }

  private start(e: Entry<R>, release: () => void): void {
    const id = e.id;
    e.state = 'searching';
    e.startedAt = this.now();
    void e
      .run(id)
      .then(
        (result) => {
          e.state = 'done';
          e.result = result;
          this.record(this.now() - (e.startedAt ?? this.now()));
        },
        (err: unknown) => {
          e.state = 'failed';
          e.error = err instanceof Error ? err.message : String(err);
          e.timedOut = this.isTimeout(err);
        },
      )
      .finally(() => {
        e.finishedAt = this.now();
        this.active = null;
        release();
        e.settle();
        this.pump();
      });
  }

  /** A timed-out hunt is not a duration sample — it measures the budget, not the source. */
  private record(ms: number): void {
    this.durations.push(ms);
    if (this.durations.length > DURATION_WINDOW) this.durations.shift();
  }

  private meanMs(): number {
    if (!this.durations.length) return this.initialMeanMs;
    return Math.round(this.durations.reduce((a, b) => a + b, 0) / this.durations.length);
  }

  private activeRemainingMs(mean: number): number {
    if (!this.active) return 0;
    const started = this.entries.get(this.active)?.startedAt ?? this.now();
    return Math.max(0, mean - (this.now() - started));
  }

  private evict(): void {
    const cutoff = this.now() - this.retainMs;
    for (const [id, e] of this.entries) {
      if (e.finishedAt !== null && e.finishedAt < cutoff) this.entries.delete(id);
    }
  }
}
