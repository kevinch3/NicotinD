import { describe, expect, it, mock } from 'bun:test';
import { ShareRescanScheduler } from './share-rescan-scheduler.js';

describe('ShareRescanScheduler', () => {
  it('fires rescan once after the debounce window', async () => {
    const rescan = mock(async () => {});
    const scheduler = new ShareRescanScheduler(rescan, { debounceMs: 10 });
    scheduler.schedule();
    expect(rescan).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 30));
    expect(rescan).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst of schedule() calls into a single rescan', async () => {
    const rescan = mock(async () => {});
    const scheduler = new ShareRescanScheduler(rescan, { debounceMs: 20 });
    for (let i = 0; i < 10; i++) scheduler.schedule();
    await new Promise((r) => setTimeout(r, 50));
    expect(rescan).toHaveBeenCalledTimes(1);
  });

  it('fires again for a schedule() after the previous rescan already ran', async () => {
    const rescan = mock(async () => {});
    const scheduler = new ShareRescanScheduler(rescan, { debounceMs: 10 });
    scheduler.schedule();
    await new Promise((r) => setTimeout(r, 30));
    scheduler.schedule();
    await new Promise((r) => setTimeout(r, 30));
    expect(rescan).toHaveBeenCalledTimes(2);
  });

  it('swallows a rescan failure instead of throwing', async () => {
    const rescan = mock(async () => {
      throw new Error('slskd unreachable');
    });
    const scheduler = new ShareRescanScheduler(rescan, { debounceMs: 10 });
    scheduler.schedule();
    await new Promise((r) => setTimeout(r, 30));
    expect(rescan).toHaveBeenCalledTimes(1);
  });
});
