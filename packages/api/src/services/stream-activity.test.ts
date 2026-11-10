import { describe, it, expect } from 'bun:test';
import { createStreamActivity } from './stream-activity.js';

/** A manual clock and timer queue, so deferral is tested without waiting. */
function fakeTime(start = 1_000_000) {
  let now = start;
  const timers: { at: number; fn: () => void }[] = [];
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      timers.push({ at: now + ms, fn });
    },
    advance(ms: number) {
      now += ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const due = timers[0];
        if (!due || due.at > now) break;
        timers.shift();
        due.fn();
      }
    },
  };
}

describe('stream activity (iOS noise-then-silence)', () => {
  const IDLE = 60_000;

  it('writes at once when nobody is streaming the file', async () => {
    const t = fakeTime();
    const activity = createStreamActivity({ idleMs: IDLE, now: t.now, setTimer: t.setTimer });
    const writes: string[] = [];
    activity.writeWhenIdle('/m/a.opus', async () => void writes.push('a'));
    await Promise.resolve();
    expect(writes).toEqual(['a']);
  });

  it('holds a write until the file has gone unstreamed for the idle window', async () => {
    const t = fakeTime();
    const activity = createStreamActivity({ idleMs: IDLE, now: t.now, setTimer: t.setTimer });
    const writes: string[] = [];
    activity.noteStreamed('/m/a.opus');
    activity.writeWhenIdle('/m/a.opus', async () => void writes.push('a'));
    t.advance(IDLE - 1);
    expect(writes).toEqual([]);
    t.advance(1);
    await Promise.resolve();
    expect(writes).toEqual(['a']);
  });

  it('keeps waiting while range requests keep arriving', async () => {
    const t = fakeTime();
    const activity = createStreamActivity({ idleMs: IDLE, now: t.now, setTimer: t.setTimer });
    const writes: string[] = [];
    activity.noteStreamed('/m/a.opus');
    activity.writeWhenIdle('/m/a.opus', async () => void writes.push('a'));
    t.advance(IDLE / 2);
    activity.noteStreamed('/m/a.opus');
    t.advance(IDLE / 2 + 1);
    expect(writes).toEqual([]);
    t.advance(IDLE / 2);
    await Promise.resolve();
    expect(writes).toEqual(['a']);
  });

  it('runs only the latest write for one file, and never touches another file', async () => {
    const t = fakeTime();
    const activity = createStreamActivity({ idleMs: IDLE, now: t.now, setTimer: t.setTimer });
    const writes: string[] = [];
    activity.noteStreamed('/m/a.opus');
    activity.writeWhenIdle('/m/a.opus', async () => void writes.push('a1'));
    activity.writeWhenIdle('/m/a.opus', async () => void writes.push('a2'));
    activity.writeWhenIdle('/m/b.opus', async () => void writes.push('b'));
    await Promise.resolve();
    expect(writes).toEqual(['b']);
    t.advance(IDLE);
    await Promise.resolve();
    expect(writes).toEqual(['b', 'a2']);
  });

  it('forgets files streamed longer ago than the idle window', () => {
    const t = fakeTime();
    const activity = createStreamActivity({ idleMs: IDLE, now: t.now, setTimer: t.setTimer });
    activity.noteStreamed('/m/a.opus');
    t.advance(IDLE + 1);
    activity.noteStreamed('/m/b.opus');
    expect(activity.trackedCount()).toBe(1);
  });

  it('swallows a failed write, which only mirrors what the database already holds', async () => {
    const t = fakeTime();
    const activity = createStreamActivity({ idleMs: IDLE, now: t.now, setTimer: t.setTimer });
    activity.writeWhenIdle('/m/a.opus', async () => {
      throw new Error('disk full');
    });
    await Promise.resolve();
    await Promise.resolve();
  });
});
