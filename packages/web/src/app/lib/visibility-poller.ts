/**
 * A poll loop that stands down while the page is hidden.
 *
 * Extracted when a fourth caller needed it (issue #717): TransferService had no
 * visibility gate at all, so every backgrounded tab, sleeping phone and idle TV
 * kept polling the job feed forever — ~75% of all traffic reaching the public
 * edge, with a flat overnight floor nobody was awake to look at.
 *
 * → docs/web-ui.md for the per-service cadence table.
 */
export interface VisibilityPollerOptions {
  /** The work itself. Awaited, so the next delay is measured from completion. */
  poll: () => void | Promise<void>;
  /** Consulted per tick, so a caller can vary its cadence (idle vs. active). */
  delayMs: () => number;
  /**
   * Cadence while the page is hidden. Omit (or return null) to pause entirely,
   * which is what a poller feeding only derived state wants. Return a number
   * when something user-visible depends on the result arriving unattended — a
   * completion toast, say.
   */
  hiddenDelayMs?: () => number | null;
  /** Fire one catch-up poll the moment the page becomes visible. Default true. */
  pollOnResume?: boolean;
}

export interface VisibilityPoller {
  start(): void;
  stop(): void;
  /** Poll now and reset the cadence. Resolves after the round-trip completes. */
  kick(): Promise<void>;
  isRunning(): boolean;
}

export function createVisibilityPoller(options: VisibilityPollerOptions): VisibilityPoller {
  const { poll, delayMs, hiddenDelayMs, pollOnResume = true } = options;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let listener: (() => void) | undefined;
  // Supersedes an in-flight poll whose schedule would otherwise land a second
  // timer alongside the one a resume or kick() just armed.
  let generation = 0;

  function isHidden(): boolean {
    if (typeof document === 'undefined') return false;
    return document.hidden;
  }

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /** Null means "do not schedule" — paused until the page comes back. */
  function nextDelay(): number | null {
    if (!isHidden()) return delayMs();
    return hiddenDelayMs?.() ?? null;
  }

  function schedule(): void {
    clearTimer();
    if (!running) return;
    const delay = nextDelay();
    if (delay === null) return;
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, delay);
  }

  async function run(): Promise<void> {
    const gen = ++generation;
    await poll();
    if (gen !== generation) return;
    schedule();
  }

  function attachListener(): void {
    if (listener || typeof document === 'undefined') return;
    listener = () => {
      if (!running) return;
      clearTimer();
      // Re-arm at the cadence that now applies rather than waiting out a timer
      // armed under the old visibility — going hidden 1 ms into a 3 s cycle
      // must not still fire at the fast rate.
      if (!isHidden() && pollOnResume) {
        void run();
        return;
      }
      schedule();
    };
    document.addEventListener('visibilitychange', listener);
  }

  function detachListener(): void {
    if (listener && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', listener);
    }
    listener = undefined;
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      attachListener();
      void run();
    },
    stop(): void {
      running = false;
      clearTimer();
      detachListener();
    },
    async kick(): Promise<void> {
      clearTimer();
      await run();
    },
    isRunning: () => running,
  };
}
