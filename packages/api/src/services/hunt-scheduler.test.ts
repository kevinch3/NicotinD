import { describe, expect, it } from 'bun:test';
import { HuntQueue } from './hunt-queue.js';
import { HuntScheduler, type HuntLane } from './hunt-scheduler.js';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** A search that runs until told to finish, and records when it started. */
function search(log: string[], name: string) {
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));
  return {
    run: async () => {
      log.push(name);
      await done;
      return name;
    },
    finish,
  };
}

describe('HuntScheduler (#1945)', () => {
  it('grants one turn at a time, and the next only on release', async () => {
    const s = new HuntScheduler();
    const order: string[] = [];
    const a = s.request('get');
    const b = s.request('get');
    void a.granted.then(() => order.push('a'));
    void b.granted.then(() => order.push('b'));
    await tick();
    expect(order).toEqual(['a']);
    (await a.granted)();
    await tick();
    expect(order).toEqual(['a', 'b']);
  });

  it('serves the highest lane first: picker, then get, then auto', async () => {
    const s = new HuntScheduler();
    const order: HuntLane[] = [];
    const running = s.request('auto');
    const release = await running.granted;
    for (const lane of ['auto', 'get', 'picker', 'get'] as const) {
      const t = s.request(lane);
      void t.granted.then((r) => {
        order.push(lane);
        r();
      });
    }
    release();
    await tick();
    await tick();
    expect(order).toEqual(['picker', 'get', 'get', 'auto']);
  });

  it('is first in, first out within a lane', async () => {
    const s = new HuntScheduler();
    const order: number[] = [];
    const release = await s.request('get').granted;
    for (const n of [1, 2, 3]) {
      void s.request('get').granted.then((r) => {
        order.push(n);
        r();
      });
    }
    release();
    await tick();
    await tick();
    expect(order).toEqual([1, 2, 3]);
  });

  it('never interrupts a running search for a higher lane', async () => {
    const s = new HuntScheduler();
    const auto = s.request('auto');
    const release = await auto.granted;
    let pickerRan = false;
    void s.request('picker').granted.then(() => (pickerRan = true));
    await tick();
    expect(pickerRan).toBe(false);
    expect(s.snapshot()).toEqual({ running: 1, waiting: { picker: 1, get: 0, auto: 0 } });
    release();
    await tick();
    expect(pickerRan).toBe(true);
  });

  it('counts what is ahead of a waiter: the running search and everyone before it', async () => {
    const s = new HuntScheduler();
    await s.request('get').granted;
    const get = s.request('get');
    const auto = s.request('auto');
    expect(get.ahead()).toBe(1);
    expect(auto.ahead()).toBe(2);
    const picker = s.request('picker');
    expect(picker.ahead()).toBe(1);
    expect(get.ahead()).toBe(2);
    expect(auto.ahead()).toBe(3);
  });

  it('a waiter can give its place up; a granted one cannot', async () => {
    const s = new HuntScheduler();
    const first = s.request('get');
    const release = await first.granted;
    const second = s.request('get');
    const third = s.request('get');
    expect(first.cancel()).toBe(false);
    expect(second.cancel()).toBe(true);
    expect(third.ahead()).toBe(1);
    let thirdRan = false;
    void third.granted.then(() => (thirdRan = true));
    release();
    await tick();
    expect(thirdRan).toBe(true);
  });

  it('a second release of the same turn changes nothing', async () => {
    const s = new HuntScheduler();
    const release = await s.request('get').granted;
    release();
    release();
    expect(s.snapshot().running).toBe(0);
  });

  it('runs as many at once as its one concurrency number says', async () => {
    const s = new HuntScheduler(2);
    const granted: number[] = [];
    for (const n of [1, 2, 3]) void s.request('get').granted.then(() => granted.push(n));
    await tick();
    expect(granted).toEqual([1, 2]);
  });
});

describe('HuntQueues sharing one scheduler (#1945)', () => {
  function queues() {
    const scheduler = new HuntScheduler();
    return {
      scheduler,
      picker: new HuntQueue<string>({ scheduler, lane: 'picker' }),
      get: new HuntQueue<string>({ scheduler, lane: 'get' }),
      auto: new HuntQueue<string>({ scheduler, lane: 'auto' }),
    };
  }

  it('run one search at a time across queues, a click ahead of unattended work', async () => {
    const q = queues();
    const log: string[] = [];
    const a1 = search(log, 'auto-1');
    const a2 = search(log, 'auto-2');
    const g1 = search(log, 'get-1');
    const p1 = search(log, 'picker-1');
    q.auto.enqueue('a1', a1.run);
    q.auto.enqueue('a2', a2.run);
    await tick();
    expect(log).toEqual(['auto-1']);
    // A Get and then a picker hunt arrive while auto-complete is searching.
    q.get.enqueue('g1', g1.run);
    q.picker.enqueue('p1', p1.run);
    await tick();
    expect(log).toEqual(['auto-1']);
    for (const s of [a1, p1, g1, a2]) {
      s.finish();
      await tick();
      await tick();
    }
    expect(log).toEqual(['auto-1', 'picker-1', 'get-1', 'auto-2']);
  });

  it('reads queued, not searching, while a hunt waits at the gate, with the searches ahead of it', async () => {
    const q = queues();
    const log: string[] = [];
    const a1 = search(log, 'auto-1');
    const g1 = search(log, 'get-1');
    const g2 = search(log, 'get-2');
    q.auto.enqueue('a1', a1.run);
    await tick();
    const first = q.get.enqueue('g1', g1.run);
    const second = q.get.enqueue('g2', g2.run);
    await tick();
    expect(q.get.status(first.id)).toMatchObject({ state: 'queued', position: 1 });
    expect(q.get.status(second.id)).toMatchObject({ state: 'queued', position: 2 });
    a1.finish();
    await tick();
    await tick();
    expect(q.get.status(first.id)?.state).toBe('searching');
    expect(q.get.status(second.id)).toMatchObject({ state: 'queued', position: 1 });
    g1.finish();
    g2.finish();
  });

  it('a hunt waiting at the gate can still be cancelled, and gives its place up', async () => {
    const q = queues();
    const log: string[] = [];
    const a1 = search(log, 'auto-1');
    const g1 = search(log, 'get-1');
    const g2 = search(log, 'get-2');
    q.auto.enqueue('a1', a1.run);
    await tick();
    const first = q.get.enqueue('g1', g1.run);
    q.get.enqueue('g2', g2.run);
    await tick();
    expect(q.get.cancel(first.id)).toBe(true);
    expect(q.get.status(first.id)).toBeNull();
    a1.finish();
    await tick();
    await tick();
    expect(log).toEqual(['auto-1', 'get-2']);
    g2.finish();
  });

  it('releases the gate when a search fails, so the next queue is not stuck', async () => {
    const q = queues();
    const log: string[] = [];
    const failing = q.get.enqueue('g1', async () => {
      throw new Error('boom');
    });
    const a1 = search(log, 'auto-1');
    q.auto.enqueue('a1', a1.run);
    await tick();
    await tick();
    expect(q.get.status(failing.id)).toMatchObject({ state: 'failed', error: 'boom' });
    expect(log).toEqual(['auto-1']);
    a1.finish();
  });

  it('a queue with no scheduler runs alone, as before', async () => {
    const log: string[] = [];
    const lone = new HuntQueue<string>();
    const s1 = search(log, 'one');
    const hunt = lone.enqueue('k', s1.run);
    await tick();
    expect(lone.status(hunt.id)?.state).toBe('searching');
    s1.finish();
  });
});
