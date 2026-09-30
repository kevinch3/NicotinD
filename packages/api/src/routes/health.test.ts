import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { healthRoutes } from './health.js';

describe('health route', () => {
  it('reports ok + the running version', async () => {
    const res = await healthRoutes('1.2.3', 'abc123').request('/');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: '1.2.3', commit: 'abc123' });
  });

  it('falls back to "unknown" when no version is provided', async () => {
    const res = await healthRoutes(undefined, '').request('/');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: 'unknown', commit: null });
  });

  // A deploy of an untagged commit verifies the build by its sha, so an image
  // built without one must say so rather than report something plausible.
  it('reports a null commit for a build that was not stamped', async () => {
    const res = await healthRoutes('1.2.3', '   ').request('/');
    expect(((await res.json()) as { commit: unknown }).commit).toBeNull();
  });

  it('reads the build commit from the image environment by default', async () => {
    const before = process.env.NICOTIND_BUILD_COMMIT;
    process.env.NICOTIND_BUILD_COMMIT = 'deadbeef';
    try {
      const res = await healthRoutes('1.2.3').request('/');
      expect(((await res.json()) as { commit: unknown }).commit).toBe('deadbeef');
    } finally {
      if (before === undefined) delete process.env.NICOTIND_BUILD_COMMIT;
      else process.env.NICOTIND_BUILD_COMMIT = before;
    }
  });
});

type Signals = {
  ok: boolean;
  load: number[];
  cpus: number;
  loopBlocks: { windowMs: number; blockedMs: number[] | null };
};

// What scripts/kpc-probe.sh pages on (#1143). Its jq paths are this shape.
describe('health signals route', () => {
  const NOW = 10 * 60 * 60 * 1000;
  function dbWith(blocks: Array<[at: number, ms: number]>): Database {
    const db = new Database(':memory:');
    applySchema(db);
    for (const [at, ms] of blocks)
      db.run('INSERT INTO loop_blocks (at, blocked_ms, in_flight) VALUES (?, ?, ?)', [
        at,
        ms,
        '["GET /api/library/secret-path (9ms)"]',
      ]);
    return db;
  }

  it('reports load and the blocks inside the window, most recent first', async () => {
    const db = dbWith([
      [NOW - 16 * 60_000, 9000], // outside the 15-minute window
      [NOW - 10 * 60_000, 1500],
      [NOW - 60_000, 6200],
    ]);
    const res = await healthRoutes('1', 'c', {
      db,
      load: () => [31.5, 12.25, 4],
      now: () => NOW,
    }).request('/signals');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Signals;
    expect(body.load).toEqual([31.5, 12.25, 4]);
    expect(body.cpus).toBeGreaterThan(0);
    expect(body.loopBlocks).toEqual({ windowMs: 15 * 60_000, blockedMs: [6200, 1500] });
  });

  it('never exposes what was in flight — the route is public', async () => {
    const db = dbWith([[NOW - 1000, 2000]]);
    const res = await healthRoutes('1', 'c', { db, now: () => NOW }).request('/signals');
    expect(await res.text()).not.toContain('secret-path');
  });

  it('reports blocks as unknown (null), not as none, when it cannot read them', async () => {
    const noDb = await healthRoutes('1', 'c').request('/signals');
    expect(((await noDb.json()) as Signals).loopBlocks.blockedMs).toBeNull();

    const db = dbWith([]);
    db.close();
    const closed = await healthRoutes('1', 'c', { db }).request('/signals');
    expect(closed.status).toBe(200);
    expect(((await closed.json()) as Signals).loopBlocks.blockedMs).toBeNull();
  });

  it('reads the real host load average by default', async () => {
    const body = (await (await healthRoutes('1', 'c').request('/signals')).json()) as Signals;
    expect(body.load).toHaveLength(3);
    for (const l of body.load) expect(Number.isFinite(l)).toBe(true);
  });
});
