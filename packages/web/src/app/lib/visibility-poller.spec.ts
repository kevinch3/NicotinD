import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createVisibilityPoller, type VisibilityPoller } from './visibility-poller';

/** Drive jsdom's `document.hidden`, which is a getter with no setter. */
function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('createVisibilityPoller', () => {
  let polls: number;
  // Stopped in afterEach: a poller left running by a failing assertion would
  // otherwise keep ticking into the next test and inflate its count.
  let created: VisibilityPoller[];

  beforeEach(() => {
    vi.useFakeTimers();
    polls = 0;
    created = [];
    setHidden(false);
  });

  afterEach(() => {
    for (const poller of created) poller.stop();
    vi.useRealTimers();
  });

  function make(
    overrides: Partial<Parameters<typeof createVisibilityPoller>[0]> = {},
  ): VisibilityPoller {
    const poller = createVisibilityPoller({
      poll: () => {
        polls++;
      },
      delayMs: () => 1_000,
      ...overrides,
    });
    created.push(poller);
    return poller;
  }

  it('polls once immediately on start, then on the delay', async () => {
    const poller = make();
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(polls).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(polls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls).toBe(2);
    poller.stop();
  });

  it('does not start a second loop when already running', async () => {
    const poller = make();
    poller.start();
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(polls).toBe(1);
    poller.stop();
  });

  it('stop() prevents any further polls', async () => {
    const poller = make();
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(polls).toBe(1);
  });

  // The #717 regression: a hidden tab polled forever, which was ~75% of all
  // traffic reaching the public edge.
  it('pauses while the page is hidden', async () => {
    const poller = make();
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(polls).toBe(1);

    setHidden(true);
    await vi.advanceTimersByTimeAsync(10 * 1_000);
    expect(polls).toBe(1);
    poller.stop();
  });

  it('fires exactly one catch-up poll on becoming visible, then re-arms', async () => {
    const poller = make();
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    setHidden(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(polls).toBe(1);

    setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(polls).toBe(2);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(polls).toBe(3);
    poller.stop();
  });

  it('skips the catch-up poll when pollOnResume is false', async () => {
    const poller = make({ pollOnResume: false });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    setHidden(true);
    await vi.advanceTimersByTimeAsync(10_000);
    setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(polls).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(polls).toBe(2);
    poller.stop();
  });

  it('polls at hiddenDelayMs while hidden instead of pausing', async () => {
    const poller = make({ hiddenDelayMs: () => 60_000 });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(polls).toBe(1);

    setHidden(true);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(polls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls).toBe(2);
    poller.stop();
  });

  it('re-arms at the slow cadence immediately on hiding, not after the visible delay', async () => {
    // Going hidden 1 ms into a 1 s visible cadence must not fire the pending
    // fast tick — otherwise the first hidden poll arrives at the fast rate.
    const poller = make({ hiddenDelayMs: () => 60_000 });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1);

    setHidden(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(polls).toBe(1);
    poller.stop();
  });

  it('consults delayMs() at each schedule so a cadence change takes effect', async () => {
    // This is what makes one poller serve TransferService's `hasActive ? 3s :
    // 30s`. The already-armed timer still fires on the old delay — the new one
    // applies from the schedule that follows it.
    let delay = 1_000;
    const poller = make({ delayMs: () => delay });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(polls).toBe(2);

    delay = 5_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(polls).toBe(3);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(polls).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls).toBe(4);
    poller.stop();
  });

  it('kick() polls immediately and resets the timer', async () => {
    const poller = make();
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(600);

    await poller.kick();
    expect(polls).toBe(2);

    // The pending 400 ms remainder of the original cycle must be gone.
    await vi.advanceTimersByTimeAsync(999);
    expect(polls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls).toBe(3);
    poller.stop();
  });

  it('kick() resolves only after the poll round-trip completes', async () => {
    let resolvePoll: (() => void) | undefined;
    const poller = make({
      poll: () =>
        new Promise<void>((resolve) => {
          polls++;
          resolvePoll = resolve;
        }),
    });
    let settled = false;
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    resolvePoll?.();

    const pending = poller.kick().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    resolvePoll?.();
    await pending;
    expect(settled).toBe(true);
    poller.stop();
  });

  it('reports isRunning()', async () => {
    const poller = make();
    expect(poller.isRunning()).toBe(false);
    poller.start();
    expect(poller.isRunning()).toBe(true);
    poller.stop();
    expect(poller.isRunning()).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
  });

  it('stays paused across a hide/show cycle after stop() — no leaked listener', async () => {
    const poller = make();
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();

    setHidden(true);
    setHidden(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(polls).toBe(1);
  });

  it('does not schedule ahead of a slow poll (no overlapping round-trips)', async () => {
    // The delay is measured from completion, not from dispatch: a poll that
    // takes longer than the cadence must not stack a queue of pending ones.
    let release: (() => void) | undefined;
    const poller = make({
      poll: () =>
        new Promise<void>((resolve) => {
          polls++;
          release = resolve;
        }),
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(polls).toBe(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(polls).toBe(1);

    release?.();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(polls).toBe(2);
    poller.stop();
  });
});
