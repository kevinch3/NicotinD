import { describe, expect, it } from 'bun:test';
import {
  ListenBrainzClient,
  normalizePopularity,
  POPULARITY_REFERENCE,
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
