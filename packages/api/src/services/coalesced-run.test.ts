import { describe, expect, it } from 'bun:test';
import { coalescedRun } from './coalesced-run.js';

function deferredJob() {
  let starts = 0;
  let active = 0;
  let maxActive = 0;
  const releases: Array<() => void> = [];
  const job = () => {
    starts++;
    active++;
    maxActive = Math.max(maxActive, active);
    return new Promise<void>((resolve) => {
      releases.push(() => {
        active--;
        resolve();
      });
    });
  };
  return {
    job,
    get starts() {
      return starts;
    },
    get maxActive() {
      return maxActive;
    },
    release: () => releases.shift()!(),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('coalescedRun', () => {
  it('collapses a burst during a run into exactly one trailing run', async () => {
    const d = deferredJob();
    const run = coalescedRun(d.job);

    const first = run();
    const burst = [run(), run(), run(), run()];
    expect(d.starts).toBe(1);

    d.release();
    await first;
    await tick();
    expect(d.starts).toBe(2);

    d.release();
    await Promise.all(burst);
    expect(d.starts).toBe(2);
    expect(d.maxActive).toBe(1);
  });

  it('starts a fresh run once idle', async () => {
    const d = deferredJob();
    const run = coalescedRun(d.job);

    const a = run();
    d.release();
    await a;

    const b = run();
    expect(d.starts).toBe(2);
    d.release();
    await b;
  });

  it('still runs the trailing job when the current one rejects', async () => {
    let calls = 0;
    let fail: (e: Error) => void = () => {};
    const run = coalescedRun(() => {
      calls++;
      if (calls === 1) return new Promise<void>((_, reject) => (fail = reject));
      return Promise.resolve();
    });

    const first = run();
    const second = run();
    fail(new Error('scan failed'));
    await expect(first).rejects.toThrow('scan failed');
    await second;
    expect(calls).toBe(2);
  });
});
