/** How long a press must last to count as a hold. */
export const LONG_PRESS_MS = 500;

/**
 * Press-and-hold on a control that already has a tap action (issue #995).
 *
 * The tricky part is not the timer, it is that a hold must **not** also fire
 * the tap: a pointer-up after a long press still produces a `click`, so
 * `shuffle` would toggle on its way to starting a radio. `end()` reports
 * whether the hold fired so the click handler can stand down, and the flag is
 * cleared there rather than on the next `start()` — otherwise a hold followed
 * by a genuine tap would swallow the tap too.
 *
 * Timer functions are injected so the timing is unit-testable without fake
 * timers or a DOM.
 */
export class LongPress {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private fired = false;

  constructor(
    private readonly onLong: () => void,
    private readonly delayMs: number = LONG_PRESS_MS,
    private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = (
      fn,
      ms,
    ) => setTimeout(fn, ms),
    private readonly clearTimer: (t: ReturnType<typeof setTimeout>) => void = clearTimeout,
  ) {}

  /** Pointer went down — arm the hold. */
  start(): void {
    this.cancel();
    this.fired = false;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.fired = true;
      this.onLong();
    }, this.delayMs);
  }

  /**
   * Pointer released. Returns true when the hold already fired, meaning the
   * caller must suppress the tap action that would otherwise follow.
   */
  end(): boolean {
    const fired = this.fired;
    this.cancel();
    this.fired = false;
    return fired;
  }

  /** Pointer left, was cancelled, or the control unmounted. */
  cancel(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }
}
