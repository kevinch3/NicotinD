import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { clampQueryInt } from './query-params.js';

async function read(query: string, opts: { fallback: number; max: number }): Promise<number> {
  const app = new Hono();
  app.get('/t', (c) => c.json({ v: clampQueryInt(c, 'size', opts) }));
  const res = await app.request(`/t${query}`);
  return ((await res.json()) as { v: number }).v;
}

/**
 * Issue #945. The idiom `Math.min(Number(c.req.query('size') ?? 60), 200)` was at
 * 12 sites and had two failure modes that both reached SQLite as a bound param.
 */
describe('clampQueryInt', () => {
  it('falls back on a non-numeric value instead of passing NaN to sqlite', async () => {
    // The reported bug: Number('abc') is NaN, Math.min(NaN, 200) is NaN, and
    // bun:sqlite rejects NaN with `datatype mismatch` — an unhandled 500 that
    // also reaches Sentry as an unknown 500.
    expect(await read('?size=abc', { fallback: 60, max: 200 })).toBe(60);
    expect(await read('?size=', { fallback: 60, max: 200 })).toBe(60);
    expect(await read('?size=NaN', { fallback: 60, max: 200 })).toBe(60);
  });

  it('falls back on zero and negatives — SQLite reads a negative LIMIT as NO limit', async () => {
    // The more interesting half: `?count=-1` on a cap-10000 endpoint was an
    // unbounded scan, not a rejected request.
    expect(await read('?size=-5', { fallback: 60, max: 200 })).toBe(60);
    expect(await read('?size=-1', { fallback: 100, max: 10000 })).toBe(100);
    expect(await read('?size=0', { fallback: 60, max: 200 })).toBe(60);
  });

  it('clamps to max and truncates a fractional value', async () => {
    expect(await read('?size=999', { fallback: 60, max: 200 })).toBe(200);
    expect(await read('?size=12.9', { fallback: 60, max: 200 })).toBe(12);
    expect(await read('?size=7', { fallback: 60, max: 200 })).toBe(7);
  });

  it('never exceeds max even via the fallback', async () => {
    expect(await read('?size=abc', { fallback: 500, max: 50 })).toBe(50);
  });

  it('produces a value bun:sqlite accepts as a bound LIMIT', async () => {
    // The empirical check from the issue, run against a real database rather
    // than reasoned about: this is what threw before.
    const db = new Database(':memory:');
    db.run('CREATE TABLE t (id INTEGER)');
    db.run('INSERT INTO t VALUES (1),(2),(3)');
    const app = new Hono();
    app.get('/t', (c) => {
      const size = clampQueryInt(c, 'size', { fallback: 2, max: 200 });
      return c.json({
        n: db.query<{ id: number }, [number]>('SELECT id FROM t LIMIT ?').all(size).length,
      });
    });
    const res = await app.request('/t?size=abc');
    expect(((await res.json()) as { n: number }).n).toBe(2);
  });
});
