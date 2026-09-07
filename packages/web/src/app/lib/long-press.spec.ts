import { describe, it, expect } from 'vitest';
import { LongPress, LONG_PRESS_MS } from './long-press';

/** A hand-driven clock: nothing fires until `run()` is called. */
function controllable() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    pending,
    set: (fn: () => void) => {
      const id = next++;
      pending.set(id, fn);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clear: (t: ReturnType<typeof setTimeout>) => {
      pending.delete(t as unknown as number);
    },
    run: () => {
      for (const fn of [...pending.values()]) fn();
      pending.clear();
    },
  };
}

describe('LongPress', () => {
  it('fires the hold action once the delay elapses', () => {
    const c = controllable();
    let fired = 0;
    const lp = new LongPress(() => fired++, LONG_PRESS_MS, c.set, c.clear);
    lp.start();
    expect(fired).toBe(0);
    c.run();
    expect(fired).toBe(1);
  });

  /**
   * The actual bug this class exists to prevent: a pointer-up after a hold
   * still produces a click, so shuffle would toggle on its way to a radio.
   */
  it('reports the fired hold so the caller can suppress the tap', () => {
    const c = controllable();
    const lp = new LongPress(() => {}, LONG_PRESS_MS, c.set, c.clear);
    lp.start();
    c.run();
    expect(lp.end()).toBe(true);
  });

  it('a short press does not fire, and does not suppress the tap', () => {
    const c = controllable();
    let fired = 0;
    const lp = new LongPress(() => fired++, LONG_PRESS_MS, c.set, c.clear);
    lp.start();
    expect(lp.end()).toBe(false);
    c.run(); // the timer was cleared by end()
    expect(fired).toBe(0);
  });

  it('a hold followed by a genuine tap does not swallow the tap', () => {
    const c = controllable();
    const lp = new LongPress(() => {}, LONG_PRESS_MS, c.set, c.clear);
    lp.start();
    c.run();
    expect(lp.end()).toBe(true);
    lp.start();
    expect(lp.end()).toBe(false);
  });

  it('cancel disarms a press that never completed', () => {
    const c = controllable();
    let fired = 0;
    const lp = new LongPress(() => fired++, LONG_PRESS_MS, c.set, c.clear);
    lp.start();
    lp.cancel();
    c.run();
    expect(fired).toBe(0);
    expect(lp.end()).toBe(false);
  });
});
