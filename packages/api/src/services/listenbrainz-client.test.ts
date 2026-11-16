import { describe, expect, it } from 'bun:test';
import {
  ListenBrainzClient,
  POPULARITY_REFERENCE,
  SIMILAR_ARTISTS_ALGORITHM,
  normalizePopularity,
} from './listenbrainz-client.js';

describe('normalizePopularity', () => {
  it('maps 0 / negative / NaN to 0 (an obscure but real recording)', () => {
    expect(normalizePopularity(0)).toBe(0);
    expect(normalizePopularity(-5)).toBe(0);
    expect(normalizePopularity(Number.NaN)).toBe(0);
  });

  it('maps the reference count to ~1 and clamps anything above it', () => {
    expect(normalizePopularity(POPULARITY_REFERENCE)).toBeCloseTo(1, 5);
    expect(normalizePopularity(POPULARITY_REFERENCE * 100)).toBe(1);
  });

  it('is monotonic and log-scaled (so the long tail is not crushed to 0)', () => {
    expect(normalizePopularity(1000)).toBeCloseTo(0.5, 2);
    expect(normalizePopularity(10)).toBeLessThan(normalizePopularity(10_000));
  });
});

const noSleep = async (): Promise<void> => {};
const frozenClock = (): number => 0;

function respondWith(counts: Record<string, number | null>): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { recording_mbids: string[] };
    const rows = body.recording_mbids.map((m) => ({
      recording_mbid: m,
      total_listen_count: m in counts ? counts[m] : null,
    }));
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('ListenBrainzClient', () => {
  it('returns listen counts keyed by recording MBID (null when LB has no data)', async () => {
    const client = new ListenBrainzClient({
      fetchFn: respondWith({ a: 100, b: 0 }),
      sleep: noSleep,
      now: frozenClock,
    });
    const m = await client.getListenCounts(['a', 'b', 'c']);
    expect(m.get('a')).toBe(100);
    expect(m.get('b')).toBe(0);
    expect(m.get('c')).toBeNull();
  });

  it('caches per MBID and does not refetch a known one', async () => {
    let calls = 0;
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      calls++;
      const body = JSON.parse(String(init?.body)) as { recording_mbids: string[] };
      return new Response(
        JSON.stringify(
          body.recording_mbids.map((m) => ({ recording_mbid: m, total_listen_count: 42 })),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new ListenBrainzClient({ fetchFn, sleep: noSleep, now: frozenClock });
    await client.getListenCounts(['a']);
    await client.getListenCounts(['a']);
    expect(calls).toBe(1);
  });

  it('loses the whole batch on a 400, so one invalid id must never reach it (issue #851)', async () => {
    // ListenBrainz validates the request before doing any work: one malformed
    // recording id rejects every id sent with it. The client cannot rescue that,
    // which is why the caller validates the tag before batching.
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { recording_mbids: string[] };
      const bad = body.recording_mbids.find((m) => !/^[0-9a-f-]{36}$/.test(m));
      if (bad) {
        return new Response(
          JSON.stringify({ code: 400, error: `recording_mbid ${bad} is not valid.` }),
          {
            status: 400,
          },
        );
      }
      return new Response(
        JSON.stringify(
          body.recording_mbids.map((m) => ({ recording_mbid: m, total_listen_count: 7 })),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new ListenBrainzClient({ fetchFn, sleep: noSleep, now: frozenClock });

    const good = '98ddbc99-af41-4722-93ea-1db8e2433878';
    const poisoned = await client.getListenCounts([good, '5333377-B5']);
    expect(poisoned.size).toBe(0); // the well-formed id is lost with the bad one

    const clean = await client.getListenCounts([good]);
    expect(clean.get(good)).toBe(7); // ...and nothing was cached against it
  });

  it('leaves a throttled MBID absent (not null) so a later pass retries it', async () => {
    let throttled = true;
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      if (throttled) {
        throttled = false;
        return new Response('', { status: 429 });
      }
      const body = JSON.parse(String(init?.body)) as { recording_mbids: string[] };
      return new Response(
        JSON.stringify(
          body.recording_mbids.map((m) => ({ recording_mbid: m, total_listen_count: 7 })),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new ListenBrainzClient({ fetchFn, sleep: noSleep, now: frozenClock });

    const first = await client.getListenCounts(['a']);
    // Transient failure → absent from the map (distinct from a null "no data"),
    // and not cached, so it is retried.
    expect(first.has('a')).toBe(false);

    const second = await client.getListenCounts(['a']);
    expect(second.get('a')).toBe(7);
  });

  it('dedupes repeated MBIDs in one request', async () => {
    let requested: string[] = [];
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { recording_mbids: string[] };
      requested = body.recording_mbids;
      return new Response(
        JSON.stringify(
          body.recording_mbids.map((m) => ({ recording_mbid: m, total_listen_count: 1 })),
        ),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new ListenBrainzClient({ fetchFn, sleep: noSleep, now: frozenClock });
    await client.getListenCounts(['a', 'a', 'a']);
    expect(requested).toEqual(['a']);
  });
});

describe('ListenBrainzClient.getSimilarArtists (#1486)', () => {
  const noSleep = async () => {};
  const clock = () => 0;
  const answering = (status: number, body: unknown) => {
    const urls: string[] = [];
    const fetchFn = (async (u: string) => {
      urls.push(u);
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    }) as unknown as typeof fetch;
    return { fetchFn, urls };
  };

  it('asks the labs API for one artist and returns the rows best first, without the artist itself', async () => {
    const { fetchFn, urls } = answering(200, [
      { artist_mbid: 'b', name: 'B', score: 5 },
      { artist_mbid: 'seed', name: 'Seed', score: 99 },
      { artist_mbid: 'a', name: 'A', score: 50 },
      { artist_mbid: 'z', name: 'Zero', score: 0 },
      { name: 'no id', score: 7 },
    ]);
    const client = new ListenBrainzClient({ fetchFn, sleep: noSleep, now: clock });
    expect(await client.getSimilarArtists('seed')).toEqual([
      { mbid: 'a', name: 'A', score: 50 },
      { mbid: 'b', name: 'B', score: 5 },
    ]);
    expect(urls[0]).toContain('labs.api.listenbrainz.org/similar-artists/json?artist_mbids=seed');
    expect(urls[0]).toContain(`algorithm=${SIMILAR_ARTISTS_ALGORITHM}`);
  });

  it('returns an empty list when the source knows nothing', async () => {
    const { fetchFn } = answering(200, []);
    const client = new ListenBrainzClient({ fetchFn, sleep: noSleep, now: clock });
    expect(await client.getSimilarArtists('seed')).toEqual([]);
  });

  it('returns null, not an empty list, for a throttle, an error status, a bad body or a throw', async () => {
    for (const [status, body] of [
      [429, []],
      [500, []],
      [200, { not: 'an array' }],
    ] as const) {
      const { fetchFn } = answering(status, body);
      const client = new ListenBrainzClient({ fetchFn, sleep: noSleep, now: clock });
      expect(await client.getSimilarArtists('seed')).toBeNull();
    }
    const throwing = (async () => {
      throw new Error('network');
    }) as unknown as typeof fetch;
    const client = new ListenBrainzClient({ fetchFn: throwing, sleep: noSleep, now: clock });
    expect(await client.getSimilarArtists('seed')).toBeNull();
  });
});
