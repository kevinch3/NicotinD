import { createLogger } from '@nicotind/core';

const log = createLogger('loop-block');

/** How often the monitor checks in. Small enough to attribute a block to the
 *  request that caused it, large enough to be free when nothing is wrong. */
export const LOOP_CHECK_INTERVAL_MS = 250;
/** Lag above this is reported. A healthy loop lags by ~1 ms; GC or a big JSON
 *  serialize can reach tens. 1 s means something occupied the process. */
export const LOOP_BLOCK_BUDGET_MS = 1_000;

export interface LoopBlock {
  /** Milliseconds the loop was unable to run timers. */
  blockedMs: number;
  /** Requests in flight when the loop came back, newest first. */
  inFlight: string[];
}

/**
 * Reports when something occupied the single Bun event loop (#1058).
 *
 * `bun:sqlite`'s `.all()` is synchronous and the library list handlers are
 * synchronous Hono handlers, so a slow query does not just make its own
 * response slow — it stops the process. During #1055 one `/artists` request
 * held the loop for 204 s: songs, cover art and the Docker health check all
 * queued behind it, and the only visible symptom was a container flapping
 * `Health check exceeded timeout (5s)`. Nothing named the query.
 *
 * This detects and attributes; it deliberately does not pre-empt, because in
 * this process nothing can. `bun:sqlite` exposes neither `sqlite3_interrupt`
 * nor a progress handler, and the list queries end in `USE TEMP B-TREE FOR
 * ORDER BY` — measured on a 3k-artist fixture, the first row arrives at
 * 2,935 ms against 2,928 ms for the whole `.all()`, so even a row-by-row
 * `iterate()` deadline could not cut one short. Pre-emption needs the query
 * off this loop entirely, which is still open on #1058.
 */
export function startLoopBlockMonitor(options: {
  inFlight: () => string[];
  onBlock?: (block: LoopBlock) => void;
  intervalMs?: number;
  budgetMs?: number;
}): () => void {
  const intervalMs = options.intervalMs ?? LOOP_CHECK_INTERVAL_MS;
  const budgetMs = options.budgetMs ?? LOOP_BLOCK_BUDGET_MS;
  let expected = performance.now() + intervalMs;

  const timer = setInterval(() => {
    const now = performance.now();
    // Lateness, not elapsed: a timer that fires on time reports ~0 no matter
    // how long the interval is, so the threshold means the same thing at any
    // interval. A legitimately slow *async* response never shows up here —
    // only work that stops timers from running at all does.
    const blockedMs = now - expected;
    expected = now + intervalMs;
    if (blockedMs < budgetMs) return;
    const block: LoopBlock = { blockedMs: Math.round(blockedMs), inFlight: options.inFlight() };
    log.warn(block, 'Event loop was blocked');
    options.onBlock?.(block);
  }, intervalMs);
  // Never hold the process open for a diagnostic.
  timer.unref?.();
  return () => clearInterval(timer);
}
