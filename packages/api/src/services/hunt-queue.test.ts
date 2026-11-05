import { describe, expect, it } from 'bun:test';
import { HuntQueue, HuntQueueFullError } from './hunt-queue.js';

/** A run the test settles by hand, so queue order is observable. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('HuntQueue (#1625)', () => {
  it('runs one hunt at a time, in arrival order', async () => {
    const q = new HuntQueue<string>();
    const started: string[] = [];
    const a = deferred<string>();
    const b = deferred<string>();
    const ida = q.enqueue('a', () => (started.push('a'), a.promise)).id;
    const idb = q.enqueue('b', () => (started.push('b'), b.promise)).id;
    await tick();
    expect(started).toEqual(['a']);
    expect(q.status(ida)!.state).toBe('searching');
    expect(q.status(idb)).toMatchObject({ state: 'queued', position: 1 });
    a.resolve('A');
    await tick();
    expect(started).toEqual(['a', 'b']);
    expect(q.status(ida)).toEqual({ state: 'done', result: 'A' });
    b.resolve('B');
    await tick();
    expect(q.status(idb)).toEqual({ state: 'done', result: 'B' });
  });

  // The whole point: time spent waiting is not billed to the hunt. The 5th hunt
  // of a burst used to time out at 55 s before it had searched at all.
  it('a hunt queued behind several others still runs and succeeds', async () => {
    const q = new HuntQueue<number>();
    const runs = Array.from({ length: 7 }, () => deferred<number>());
    const ids = runs.map((d, i) => q.enqueue(`album-${i}`, () => d.promise).id);
    for (let i = 0; i < runs.length; i++) {
      await tick();
      expect(q.status(ids[i]!)!.state).toBe('searching');
      runs[i]!.resolve(i);
    }
    await tick();
    for (let i = 0; i < ids.length; i++)
      expect(q.status(ids[i]!)).toEqual({ state: 'done', result: i });
  });

  it('the same album hunted twice joins the hunt already waiting', () => {
    const q = new HuntQueue<string>();
    const hold = deferred<string>();
    q.enqueue('busy', () => hold.promise);
    const first = q.enqueue('album-7', async () => 'x');
    const again = q.enqueue('album-7', async () => 'y');
    expect(again).toEqual({ id: first.id, joined: true });
  });

  it('estimates the wait from how long finished hunts took', async () => {
    let now = 1_000;
    const q = new HuntQueue<string>({ now: () => now, initialMeanMs: 12_000 });
    const a = deferred<string>();
    q.enqueue('a', () => a.promise);
    const idb = q.enqueue('b', async () => 'b').id;
    const idc = q.enqueue('c', async () => 'c').id;
    await tick();
    // One searching (just started), b next: one mean-length hunt ahead of b.
    expect(q.status(idb)).toEqual({ state: 'queued', position: 1, etaMs: 12_000 });
    expect(q.status(idc)).toEqual({ state: 'queued', position: 2, etaMs: 24_000 });
    now += 20_000;
    // The running hunt is over its estimate: nothing negative, b is "any moment".
    expect(q.status(idb)).toMatchObject({ position: 1, etaMs: 0 });
  });

  it('the estimate follows measured hunt durations', async () => {
    let now = 0;
    const q = new HuntQueue<string>({ now: () => now, initialMeanMs: 12_000 });
    const a = deferred<string>();
    q.enqueue('a', () => a.promise);
    await tick();
    now = 30_000;
    a.resolve('a');
    await tick();
    const hold = deferred<string>();
    q.enqueue('h', () => hold.promise);
    const idx = q.enqueue('x', async () => 'x').id;
    await tick();
    expect(q.status(idx)).toEqual({ state: 'queued', position: 1, etaMs: 30_000 });
  });

  it('a failed hunt reports why, and the next one still runs', async () => {
    const q = new HuntQueue<string>({ isTimeout: (e) => e instanceof RangeError });
    const ida = q.enqueue('a', async () => {
      throw new RangeError('took too long');
    }).id;
    const idb = q.enqueue('b', async () => 'ok').id;
    await tick();
    await tick();
    expect(q.status(ida)).toEqual({ state: 'failed', error: 'took too long', timedOut: true });
    expect(q.status(idb)).toEqual({ state: 'done', result: 'ok' });
  });

  it('cancel takes a hunt out of the queue before it ever runs', async () => {
    const q = new HuntQueue<string>();
    const hold = deferred<string>();
    let ran = false;
    q.enqueue('a', () => hold.promise);
    const idb = q.enqueue('b', async () => ((ran = true), 'b')).id;
    expect(q.cancel(idb)).toBe(true);
    hold.resolve('a');
    await tick();
    await tick();
    expect(ran).toBe(false);
    expect(q.status(idb)).toBeNull();
  });

  it('wait() resolves with the result, or rejects with the failure', async () => {
    const q = new HuntQueue<string>();
    const ok = q.enqueue('a', async () => 'A').id;
    const bad = q.enqueue('b', async () => {
      throw new Error('nope');
    }).id;
    await expect(q.wait(ok)).resolves.toBe('A');
    await expect(q.wait(bad)).rejects.toThrow('nope');
  });

  it('forgets finished hunts after the retention window', async () => {
    let now = 0;
    const q = new HuntQueue<string>({ now: () => now, retainMs: 60_000 });
    const id = q.enqueue('a', async () => 'A').id;
    await tick();
    expect(q.status(id)).toEqual({ state: 'done', result: 'A' });
    now += 60_001;
    expect(q.status(id)).toBeNull();
  });

  it('refuses past its capacity instead of growing without bound', () => {
    const q = new HuntQueue<string>({ maxQueued: 2 });
    const hold = deferred<string>();
    q.enqueue('a', () => hold.promise);
    q.enqueue('b', () => hold.promise);
    q.enqueue('c', () => hold.promise);
    expect(() => q.enqueue('d', () => hold.promise)).toThrow(HuntQueueFullError);
  });
});
