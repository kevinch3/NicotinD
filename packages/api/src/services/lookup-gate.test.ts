import { describe, expect, it } from 'bun:test';
import { GATED_LOOKUP_TOOLS, LOOKUP_CONCURRENCY, LookupGate } from './lookup-gate.js';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** A job that runs until told to finish, recording the peak overlap. */
function harness(gate: LookupGate) {
  let active = 0;
  let peak = 0;
  const started: number[] = [];
  const finishers: Array<() => void> = [];
  const job = (n: number) =>
    gate.run(async () => {
      started.push(n);
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((r) => finishers.push(r));
      active--;
      return n;
    });
  return { job, started, finishers, peak: () => peak };
}

describe('LookupGate (#757)', () => {
  it('never runs more than its size at once, and runs the rest in arrival order', async () => {
    const gate = new LookupGate(3);
    const h = harness(gate);
    const all = [1, 2, 3, 4, 5, 6].map(h.job);
    await tick();
    expect(h.started).toEqual([1, 2, 3]);
    expect(gate.snapshot()).toEqual({ running: 3, waiting: 3 });
    while (h.finishers.length) {
      h.finishers.shift()!();
      await tick();
      await tick();
    }
    expect(await Promise.all(all)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(h.started).toEqual([1, 2, 3, 4, 5, 6]);
    expect(h.peak()).toBe(3);
    expect(gate.snapshot()).toEqual({ running: 0, waiting: 0 });
  });

  it('gives the place back when a lookup throws', async () => {
    const gate = new LookupGate(1);
    await expect(
      gate.run(async () => {
        throw new Error('source down');
      }),
    ).rejects.toThrow('source down');
    expect(gate.snapshot()).toEqual({ running: 0, waiting: 0 });
    expect(await gate.run(async () => 'next')).toBe('next');
  });

  it('a caller arriving as a place frees does not jump the queue', async () => {
    const gate = new LookupGate(1);
    const h = harness(gate);
    const first = h.job(1);
    const second = h.job(2);
    await tick();
    h.finishers.shift()!();
    const third = h.job(3);
    await tick();
    await tick();
    expect(h.started).toEqual([1, 2]);
    h.finishers.shift()!();
    await tick();
    await tick();
    h.finishers.shift()!();
    expect(await Promise.all([first, second, third])).toEqual([1, 2, 3]);
  });

  it('gates the two fan-out tools and nothing else, three at a time', () => {
    expect([...GATED_LOOKUP_TOOLS].sort()).toEqual([
      'lookup_album_metadata',
      'lookup_song_metadata',
    ]);
    expect(LOOKUP_CONCURRENCY).toBe(3);
  });
});
