import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { runLibrarySyncCycle } from './library-sync-cycle.js';
import { yieldToEventLoop } from './loop-block-monitor.js';

function busy(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    /* hold the thread, like a synchronous SQL phase */
  }
}

/** Longest stretch the loop could not run a timer while `fn` ran. */
async function maxLoopGap(fn: () => Promise<void>): Promise<number> {
  let last = performance.now();
  let max = 0;
  const tick = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last);
    last = now;
  }, 5);
  try {
    await fn();
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    clearInterval(tick);
  }
  return max;
}

describe('runLibrarySyncCycle (#1313)', () => {
  it('runs every step, in order', async () => {
    const order: string[] = [];
    await runLibrarySyncCycle({
      scanFull: async () => void order.push('scan'),
      reclassifyAll: () => void order.push('reclassify'),
      backfillAcquisitions: () => void order.push('backfill'),
      kickEnrichment: () => void order.push('kick'),
    });
    expect(order).toEqual(['scan', 'reclassify', 'backfill', 'kick']);
  });

  it('lets the event loop run between synchronous steps', async () => {
    const gap = await maxLoopGap(() =>
      runLibrarySyncCycle({
        scanFull: async () => busy(120),
        reclassifyAll: () => busy(120),
        backfillAcquisitions: () => busy(120),
        kickEnrichment: () => {},
      }),
    );
    // Back to back the three steps are one ~360 ms block; with a turn between
    // the first two and the last, no stretch is longer than two of them.
    expect(gap).toBeLessThan(300);
  });
});

describe('yieldToEventLoop', () => {
  it('lets a due timer run, which an await on a settled promise does not', async () => {
    let fired = false;
    setTimeout(() => (fired = true), 0);
    busy(5);
    await Promise.resolve();
    expect(fired).toBe(false);
    await yieldToEventLoop();
    expect(fired).toBe(true);
  });
});

describe('the processing batch yields between tasks', () => {
  it('processOneBatch awaits yieldToEventLoop inside its task loop', () => {
    const src = readFileSync(join(import.meta.dir, 'library-processing.service.ts'), 'utf8');
    const loop = src.slice(src.indexOf('for (const task of tasks) {'));
    expect(loop.slice(0, loop.indexOf('task.run('))).toContain('await yieldToEventLoop();');
  });
});
