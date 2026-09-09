import { describe, expect, it } from 'bun:test';
import { startLoopBlockMonitor, type LoopBlock } from './loop-block-monitor.js';

/** Occupy the loop the way a synchronous `.all()` does — no awaits inside. */
function blockFor(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    /* spin */
  }
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('startLoopBlockMonitor', () => {
  it('reports a synchronous block, with the request that was in flight', async () => {
    const blocks: LoopBlock[] = [];
    const stop = startLoopBlockMonitor({
      inFlight: () => ['GET /api/library/artists?country (300ms)'],
      onBlock: (b) => blocks.push(b),
      intervalMs: 20,
      budgetMs: 100,
    });
    try {
      blockFor(400);
      await tick(60);
    } finally {
      stop();
    }
    expect(blocks.length).toBeGreaterThan(0);
    // Lateness, not elapsed: the reported figure is the block, not the interval.
    expect(blocks[0]!.blockedMs).toBeGreaterThan(100);
    expect(blocks[0]!.inFlight).toEqual(['GET /api/library/artists?country (300ms)']);
  });

  it('stays silent while the loop is free, however long an async wait runs', async () => {
    const blocks: LoopBlock[] = [];
    const stop = startLoopBlockMonitor({
      inFlight: () => [],
      onBlock: (b) => blocks.push(b),
      intervalMs: 10,
      budgetMs: 100,
    });
    try {
      // A slow *async* response (a long stream) must not be reported: it never
      // stops timers running. This is why the monitor measures timer lateness
      // rather than request duration.
      await tick(300);
    } finally {
      stop();
    }
    expect(blocks).toEqual([]);
  });

  it('stops reporting once stopped', async () => {
    const blocks: LoopBlock[] = [];
    const stop = startLoopBlockMonitor({
      inFlight: () => [],
      onBlock: (b) => blocks.push(b),
      intervalMs: 10,
      budgetMs: 50,
    });
    stop();
    blockFor(200);
    await tick(50);
    expect(blocks).toEqual([]);
  });
});
