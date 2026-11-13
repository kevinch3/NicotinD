import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';
import { albumGetRetryDelayMs } from './album-get-retry.js';
import {
  autoCompleteCandidates,
  markAutoResourceExhausted,
  recordAutoResourceAttempt,
} from './acquisition-job-store.js';
import { HuntQueue } from './hunt-queue.js';
import { resolveResourceTarget, searchAlternates, switchToPeer } from './job-resource.js';

const log = createLogger('auto-complete');

/** Hand-overs per card. The first finds most partials their rest; a second catches a peer that half-delivered. */
export const AUTO_RESOURCE_MAX_ATTEMPTS = 2;
/** Nobody waits on this search, so it gets the unattended lanes' budget. */
const AUTO_HUNT_TIMEOUT_MS = 120_000;
/** A restart resumes partials this recent, never the whole history. */
const BOOT_RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;

export type AutoCompleteOutcome =
  'switched' | 'no-alternate' | 'source-unavailable' | 'not-eligible' | 'failed';

export interface AutoCompleteDeps {
  db: Database;
  /** The registry lookup the routes use: an addon id to its plugin. */
  getPlugin: (addonId: string) => unknown;
  /** `downloads.autoCompletePartial` and the deployment kill-switch, read per call. */
  enabled: () => boolean;
  maxAttempts?: number;
  retryDelayMs?: (attempt: number) => number | null;
  schedule?: (fn: () => void, ms: number) => void;
  now?: () => number;
}

/**
 * A partial album completes itself from another peer (#1879): when a card
 * closes `done` with tracks missing, run the search and the hand-over the
 * "Complete from another peer" button runs, without the click. Both share
 * services/job-resource.ts, so the pick has one home.
 * → docs/download-pipeline.md "A partial completes itself".
 */
export class AutoCompleteService {
  // Its own queue, one search at a time: a burst of closing partials must not
  // flood the source's search lanes ahead of someone's click (#1625).
  private readonly queue = new HuntQueue<AutoCompleteOutcome>({ maxQueued: 500 });
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly maxAttempts: number;
  private readonly retryDelayMs: (attempt: number) => number | null;
  private readonly schedule: (fn: () => void, ms: number) => void;
  private readonly now: () => number;

  constructor(private readonly deps: AutoCompleteDeps) {
    this.maxAttempts = deps.maxAttempts ?? AUTO_RESOURCE_MAX_ATTEMPTS;
    this.retryDelayMs = deps.retryDelayMs ?? albumGetRetryDelayMs;
    this.schedule =
      deps.schedule ??
      ((fn, ms) => {
        setTimeout(fn, ms).unref?.();
      });
    this.now = deps.now ?? Date.now;
  }

  /** The poller's word that a card's addon job closed and nothing is left to ingest. */
  onJobClosed(jobId: string): void {
    if (!this.deps.enabled() || this.inFlight.has(jobId)) return;
    if (!this.eligible(jobId)) return;
    this.enqueue(jobId, 1);
  }

  /** Queue every recent partial a restart interrupted. */
  resumePending(): number {
    if (!this.deps.enabled()) return 0;
    const ids = autoCompleteCandidates(this.deps.db, {
      maxAttempts: this.maxAttempts,
      since: this.now() - BOOT_RESUME_WINDOW_MS,
    });
    for (const id of ids) if (!this.inFlight.has(id)) this.enqueue(id, 1);
    if (ids.length) log.info({ count: ids.length }, 'Resumed partial albums to complete');
    return ids.length;
  }

  /** Resolves once the card's current attempt has run — for tests and shutdown. */
  async settled(jobId: string): Promise<void> {
    await this.inFlight.get(jobId);
  }

  private eligible(jobId: string): boolean {
    return (
      autoCompleteCandidates(this.deps.db, { maxAttempts: this.maxAttempts, jobId }).length > 0
    );
  }

  private enqueue(jobId: string, attempt: number): void {
    try {
      const { id } = this.queue.enqueue(jobId, async () => {
        const outcome = await this.run(jobId);
        this.conclude(jobId, attempt, outcome);
        return outcome;
      });
      const done = this.queue.wait(id).then(
        () => {},
        () => {},
      );
      this.inFlight.set(jobId, done);
      void done.then(() => {
        if (this.inFlight.get(jobId) === done) this.inFlight.delete(jobId);
      });
    } catch (err) {
      log.warn({ jobId, err }, 'Could not queue the automatic completion');
    }
  }

  private async run(jobId: string): Promise<AutoCompleteOutcome> {
    const { db, getPlugin } = this.deps;
    // Re-checked at the head of the queue: the card may have been completed,
    // cancelled, removed or re-sourced by hand while it waited.
    if (!this.deps.enabled() || !this.eligible(jobId)) return 'not-eligible';
    const target = resolveResourceTarget(db, getPlugin, jobId);
    if ('error' in target) return 'not-eligible';

    let found;
    try {
      found = await searchAlternates(db, target, {
        timeoutMs: AUTO_HUNT_TIMEOUT_MS,
        lane: 'resource-auto',
      });
    } catch (err) {
      log.warn({ jobId, err }, 'Automatic completion search failed');
      recordAutoResourceAttempt(db, jobId);
      return 'failed';
    }
    if (!found) return 'not-eligible';
    if (!found.alternates.length) {
      // Throttled or offline is "we could not look", not "nobody has it".
      if (found.sourceOffline || found.rateLimited) return 'source-unavailable';
      markAutoResourceExhausted(db, jobId, this.now());
      log.info({ jobId, missing: found.wanted.length }, 'No other peer has the missing tracks');
      return 'no-alternate';
    }

    // The search took up to two minutes: someone may have acted on the card.
    if (!this.eligible(jobId)) return 'not-eligible';
    const fresh = resolveResourceTarget(db, getPlugin, jobId);
    if ('error' in fresh) return 'not-eligible';
    const pick = found.alternates[0]!;
    recordAutoResourceAttempt(db, jobId);
    const result = await switchToPeer(db, fresh, pick.candidateRef);
    if (result.status !== 'switched') {
      log.warn({ jobId, status: result.status }, 'Automatic completion hand-over refused');
      return 'failed';
    }
    log.info(
      {
        jobId,
        peer: pick.username,
        format: pick.format,
        tracks: result.titles.length,
        addonJobId: result.addonJobId,
      },
      'Completing a partial album from another peer',
    );
    return 'switched';
  }

  private conclude(jobId: string, attempt: number, outcome: AutoCompleteOutcome): void {
    if (outcome !== 'source-unavailable') return;
    const delay = this.retryDelayMs(attempt);
    if (delay === null) return;
    this.schedule(() => {
      if (!this.inFlight.has(jobId) && this.eligible(jobId)) this.enqueue(jobId, attempt + 1);
    }, delay);
  }
}
