import { describe, expect, it, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiscogsClient, type DiscogsClientConfig } from './client.js';

interface FakeRes {
  status: number;
  body?: unknown;
  /** X-Discogs-Ratelimit-Remaining header value (null = header absent). */
  remaining?: string | null;
}

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
}

/** A fetch fake: scripted responses (array consumed in order, or a fn) + call log. */
function makeFetch(script: FakeRes[] | ((url: string) => FakeRes)): {
  fetchFn: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetchFn = (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const r =
      typeof script === 'function' ? script(url) : script[Math.min(i++, script.length - 1)]!;
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      json: async () => r.body ?? {},
      headers: {
        get: (h: string) =>
          h.toLowerCase() === 'x-discogs-ratelimit-remaining' ? (r.remaining ?? null) : null,
      },
    };
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const baseConfig = (over: Partial<DiscogsClientConfig> = {}): DiscogsClientConfig => ({
  consumerKey: 'KEY',
  consumerSecret: 'SECRET',
  userAgent: 'NicotinD-test/1.0',
  cacheTtlDays: 30,
  ...over,
});

/** A clock whose `sleep` advances `now`, so the token bucket refills in tests. */
function fakeClock() {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    slept,
  };
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('DiscogsClient requests', () => {
  it('returns parsed JSON on 200', async () => {
    const { fetchFn } = makeFetch([{ status: 200, body: { id: 1, genres: ['Rock'] } }]);
    const client = new DiscogsClient(baseConfig(), { fetchFn, ...fakeClock() });
    expect(await client.getRelease(1)).toEqual({ id: 1, genres: ['Rock'] });
  });

  it('returns null on 404', async () => {
    const { fetchFn, calls } = makeFetch([{ status: 404 }]);
    const client = new DiscogsClient(baseConfig(), { fetchFn, ...fakeClock() });
    expect(await client.getRelease(999)).toBeNull();
    expect(calls).toHaveLength(1); // authoritative — no retry
  });

  it('retries a 429 then succeeds', async () => {
    const { fetchFn, calls } = makeFetch([
      { status: 429 },
      { status: 200, body: { id: 2, genres: ['Folk'] } },
    ]);
    const client = new DiscogsClient(baseConfig(), { fetchFn, ...fakeClock() });
    expect(await client.getRelease(2)).toEqual({ id: 2, genres: ['Folk'] });
    expect(calls).toHaveLength(2);
  });

  it('gives up (null) after exhausting retries on a persistent 5xx', async () => {
    const { fetchFn, calls } = makeFetch([
      { status: 503, body: { message: 'Query time exceeded' } },
    ]);
    const client = new DiscogsClient(baseConfig(), { fetchFn, ...fakeClock() });
    expect(await client.getRelease(3)).toBeNull();
    expect(calls).toHaveLength(3); // MAX_ATTEMPTS
  });

  it('sends the User-Agent + Discogs auth header on every request', async () => {
    const { fetchFn, calls } = makeFetch([{ status: 503 }]); // 3 attempts → 3 calls
    const client = new DiscogsClient(baseConfig({ userAgent: 'UA/9' }), {
      fetchFn,
      ...fakeClock(),
    });
    await client.getRelease(4);
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.headers['User-Agent']).toBe('UA/9');
      expect(c.headers['Authorization']).toBe('Discogs key=KEY, secret=SECRET');
    }
  });

  it('serves a repeated request from cache (one fetch)', async () => {
    const { fetchFn, calls } = makeFetch(() => ({
      status: 200,
      body: { id: 1, genres: ['Rock'] },
    }));
    const client = new DiscogsClient(baseConfig(), { fetchFn, ...fakeClock() });
    await client.getRelease(1);
    await client.getRelease(1);
    expect(calls).toHaveLength(1);
  });

  it('round-trips the cache to disk (a fresh client reuses it, no fetch)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'discogs-cache-'));
    tmpDirs.push(dir);
    const cacheFile = join(dir, 'cache.json');

    const first = makeFetch(() => ({ status: 200, body: { id: 7, genres: ['Jazz'] } }));
    const a = new DiscogsClient(baseConfig({ cacheFile }), {
      fetchFn: first.fetchFn,
      ...fakeClock(),
    });
    expect(await a.getRelease(7)).toEqual({ id: 7, genres: ['Jazz'] });

    // A new client on the same file must not touch the network.
    const throwing = (async () => {
      throw new Error('should not fetch — expected a disk cache hit');
    }) as unknown as typeof fetch;
    const b = new DiscogsClient(baseConfig({ cacheFile }), { fetchFn: throwing, ...fakeClock() });
    expect(await b.getRelease(7)).toEqual({ id: 7, genres: ['Jazz'] });
    expect(first.calls).toHaveLength(1);
  });

  it('honors X-Discogs-Ratelimit-Remaining (throttles the next request when 0)', async () => {
    const clock = fakeClock();
    const { fetchFn } = makeFetch([
      { status: 200, body: { id: 1 }, remaining: '0' },
      { status: 200, body: { id: 2 }, remaining: '55' },
    ]);
    const client = new DiscogsClient(baseConfig(), { fetchFn, now: clock.now, sleep: clock.sleep });
    await client.getRelease(1); // response says 0 remaining → bucket drained to 0
    expect(clock.slept).toHaveLength(0); // first request didn't need to wait
    await client.getRelease(2); // now the bucket is empty → must wait to refill
    expect(clock.slept.length).toBeGreaterThan(0);
  });

  it('search unwraps the results array', async () => {
    const { fetchFn, calls } = makeFetch([
      { status: 200, body: { results: [{ id: 1, type: 'release', title: 'A - B' }] } },
    ]);
    const client = new DiscogsClient(baseConfig(), { fetchFn, ...fakeClock() });
    const hits = await client.search({ artist: 'A', release_title: 'B', type: 'release' });
    expect(hits).toEqual([{ id: 1, type: 'release', title: 'A - B' }]);
    expect(calls[0]!.url).toContain('/database/search?');
  });
});
