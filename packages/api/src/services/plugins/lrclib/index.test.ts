import { describe, expect, it, mock } from 'bun:test';
import { validatePluginManifest } from '@nicotind/core';
import { LrclibPlugin } from './index.js';

/**
 * A fetch fake that maps URL substrings to {status, body} and records every URL
 * it was called with. Matching on substring alone cannot see query strings —
 * which is exactly how a duration-blind /search shipped (issue #1212), so the
 * recorded `calls` are what the param assertions below read.
 */
function routeFetch(
  routes: Array<{ match: string; status: number; body: unknown }>,
): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = mock(async (url: string) => {
    calls.push(url);
    const route = routes.find((r) => url.includes(r.match));
    if (!route) return { ok: false, status: 500, json: async () => ({}) };
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      json: async () => route.body,
    };
  }) as unknown as typeof fetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}

/** The query string of the first recorded call whose URL contains `path`. */
function paramsFor(fetchFn: { calls: string[] }, path: string): URLSearchParams {
  const url = fetchFn.calls.find((c) => c.includes(path));
  if (!url) throw new Error(`no call to ${path}; saw ${JSON.stringify(fetchFn.calls)}`);
  return new URL(url).searchParams;
}

const query = { title: 'Selva', artist: 'La Portuaria', durationSec: 200 };

describe('LrclibPlugin manifest', () => {
  it('is a valid metadata plugin and may default-enable', () => {
    const plugin = new LrclibPlugin();
    expect(validatePluginManifest(plugin.manifest)).toEqual([]);
    expect(plugin.manifest.kind).toBe('metadata');
    expect(plugin.manifest.defaultEnabled).toBe(true);
  });
});

describe('LrclibPlugin.fetchLyrics', () => {
  it('returns plain + synced from the exact /get hit', async () => {
    const fetchFn = routeFetch([
      {
        match: '/get',
        status: 200,
        body: { plainLyrics: 'line one\nline two', syncedLyrics: '[00:01.00]line one' },
      },
    ]);
    const plugin = new LrclibPlugin({ enabled: true }, { fetchFn });
    const result = await plugin.lyrics.fetchLyrics(query);
    expect(result).toEqual({
      plain: 'line one\nline two',
      synced: '[00:01.00]line one',
      source: 'lrclib',
    });
  });

  it('falls back to /search when /get 404s', async () => {
    const fetchFn = routeFetch([
      { match: '/get', status: 404, body: { code: 404 } },
      { match: '/search', status: 200, body: [{ plainLyrics: 'searched words' }] },
    ]);
    const plugin = new LrclibPlugin({ enabled: true }, { fetchFn });
    const result = await plugin.lyrics.fetchLyrics(query);
    expect(result?.plain).toBe('searched words');
    expect(result?.synced).toBeNull();
  });

  it('returns null when neither endpoint has lyrics', async () => {
    const fetchFn = routeFetch([
      { match: '/get', status: 404, body: { code: 404 } },
      { match: '/search', status: 200, body: [] },
    ]);
    const plugin = new LrclibPlugin({ enabled: true }, { fetchFn });
    expect(await plugin.lyrics.fetchLyrics(query)).toBeNull();
  });

  it('treats an empty-string lyrics body as no lyrics (instrumental)', async () => {
    const fetchFn = routeFetch([
      { match: '/get', status: 200, body: { plainLyrics: '', syncedLyrics: '' } },
      { match: '/search', status: 200, body: [] },
    ]);
    const plugin = new LrclibPlugin({ enabled: true }, { fetchFn });
    expect(await plugin.lyrics.fetchLyrics(query)).toBeNull();
  });

  it('retries a transient failure and succeeds on a later attempt (1-click reliability)', async () => {
    let getCalls = 0;
    // /get returns 429 (rate-limited) the first time, then the real lyrics.
    const fetchFn = mock(async (url: string) => {
      if (url.includes('/get')) {
        getCalls += 1;
        if (getCalls === 1) return { ok: false, status: 429, json: async () => ({}) };
        return {
          ok: true,
          status: 200,
          json: async () => ({ plainLyrics: 'recovered lyrics' }),
        };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    }) as unknown as typeof fetch;

    const plugin = new LrclibPlugin({ enabled: true }, { fetchFn, retryBackoffMs: 0 });
    const result = await plugin.lyrics.fetchLyrics(query);
    expect(result?.plain).toBe('recovered lyrics');
    expect(getCalls).toBe(2);
  });

  it('throws after exhausting retries on a persistent 5xx (not a false "no lyrics")', async () => {
    let getCalls = 0;
    const fetchFn = mock(async (url: string) => {
      if (url.includes('/get')) {
        getCalls += 1;
        return { ok: false, status: 503, json: async () => ({}) };
      }
      return { ok: false, status: 503, json: async () => ({}) };
    }) as unknown as typeof fetch;

    const plugin = new LrclibPlugin({ enabled: true }, { fetchFn, retryBackoffMs: 0 });
    await expect(plugin.lyrics.fetchLyrics(query)).rejects.toThrow(/LRCLIB request failed/);
    expect(getCalls).toBe(3); // MAX_ATTEMPTS
  });

  it('does not retry a 404 (authoritative no-match) before falling back to /search', async () => {
    let getCalls = 0;
    const fetchFn = mock(async (url: string) => {
      if (url.includes('/get')) {
        getCalls += 1;
        return { ok: false, status: 404, json: async () => ({ code: 404 }) };
      }
      return { ok: true, status: 200, json: async () => [] };
    }) as unknown as typeof fetch;

    const plugin = new LrclibPlugin({ enabled: true }, { fetchFn, retryBackoffMs: 0 });
    expect(await plugin.lyrics.fetchLyrics(query)).toBeNull();
    expect(getCalls).toBe(1); // 404 short-circuits — no retry
  });
});

/**
 * Issue #1212. The /search fallback used to send only `q=<artist> <title>` and
 * return the first hit carrying any text, never reading the hit's `duration`.
 * A library's lyrics row was then indistinguishable from a good match, and a
 * re-fetch replayed the identical query — so the wrong words could not be
 * corrected by any amount of retrying.
 */
describe('LrclibPlugin /search fallback is duration-aware', () => {
  const searchOnly = (body: unknown) =>
    routeFetch([
      { match: '/get', status: 404, body: { code: 404 } },
      { match: '/search', status: 200, body },
    ]);

  it('sends the duration and structured fields to /get', async () => {
    const fetchFn = searchOnly([]);
    const plugin = new LrclibPlugin({ enabled: true }, { fetchFn });
    await plugin.lyrics.fetchLyrics({ ...query, album: 'Rosa' });
    const params = paramsFor(fetchFn, '/get');
    expect(params.get('artist_name')).toBe('La Portuaria');
    expect(params.get('track_name')).toBe('Selva');
    expect(params.get('album_name')).toBe('Rosa');
    expect(params.get('duration')).toBe('200');
  });

  it('searches on structured fields, not one free-text q blob', async () => {
    const fetchFn = searchOnly([]);
    const plugin = new LrclibPlugin({ enabled: true }, { fetchFn });
    await plugin.lyrics.fetchLyrics(query);
    const params = paramsFor(fetchFn, '/search');
    expect(params.get('artist_name')).toBe('La Portuaria');
    expect(params.get('track_name')).toBe('Selva');
  });

  it('picks the closest duration, not the first hit', async () => {
    // First hit is a different recording; the second is ours. The old code took
    // the first and stored another take's timings verbatim.
    const fetchFn = searchOnly([
      { duration: 305, plainLyrics: 'a much longer take' },
      { duration: 201, plainLyrics: 'the right words', syncedLyrics: '[00:01.00]the right words' },
    ]);
    const plugin = new LrclibPlugin({ enabled: true }, { fetchFn });
    const result = await plugin.lyrics.fetchLyrics(query);
    expect(result?.plain).toBe('the right words');
    expect(result?.matchedDurationSec).toBe(201);
  });

  it('rejects every hit when none is close enough, rather than storing wrong words', async () => {
    const fetchFn = searchOnly([
      { duration: 140, plainLyrics: 'too short to be this song' },
      { duration: 402, plainLyrics: 'too long to be this song' },
    ]);
    const plugin = new LrclibPlugin({ enabled: true }, { fetchFn });
    expect(await plugin.lyrics.fetchLyrics(query)).toBeNull();
  });

  it('prefers a synced hit over a plain one at the same distance', async () => {
    const fetchFn = searchOnly([
      { duration: 202, plainLyrics: 'plain only' },
      { duration: 202, plainLyrics: 'also plain', syncedLyrics: '[00:02.00]with timings' },
    ]);
    const plugin = new LrclibPlugin({ enabled: true }, { fetchFn });
    const result = await plugin.lyrics.fetchLyrics(query);
    expect(result?.synced).toBe('[00:02.00]with timings');
  });

  it('reports the matched duration and track id so the host can judge the match', async () => {
    const fetchFn = routeFetch([
      {
        match: '/get',
        status: 200,
        body: { id: 4242, duration: 199, plainLyrics: 'exact hit' },
      },
    ]);
    const plugin = new LrclibPlugin({ enabled: true }, { fetchFn });
    const result = await plugin.lyrics.fetchLyrics(query);
    expect(result?.matchedDurationSec).toBe(199);
    expect(result?.sourceTrackId).toBe('4242');
  });

  it('takes a hit that states no duration, but leaves it marked unverified', async () => {
    const fetchFn = searchOnly([{ plainLyrics: 'no duration given' }]);
    const plugin = new LrclibPlugin({ enabled: true }, { fetchFn });
    const result = await plugin.lyrics.fetchLyrics(query);
    expect(result?.plain).toBe('no duration given');
    // The absent field is the signal: the host records this as unverified
    // rather than as a match it checked.
    expect(result?.matchedDurationSec).toBeUndefined();
  });

  it('prefers a duration-verified hit over an unranked one', async () => {
    const fetchFn = searchOnly([
      { plainLyrics: 'no duration given' },
      { duration: 200, plainLyrics: 'verified words' },
    ]);
    const plugin = new LrclibPlugin({ enabled: true }, { fetchFn });
    expect((await plugin.lyrics.fetchLyrics(query))?.plain).toBe('verified words');
  });

  it('still returns a hit when the song duration is unknown — it just cannot rank', async () => {
    // Degrading to "first with text" is honest here; what must not happen is
    // silently claiming a duration we never verified.
    const fetchFn = searchOnly([{ duration: 305, plainLyrics: 'unrankable but real' }]);
    const plugin = new LrclibPlugin({ enabled: true }, { fetchFn });
    const result = await plugin.lyrics.fetchLyrics({ title: 'Selva', artist: 'La Portuaria' });
    expect(result?.plain).toBe('unrankable but real');
    expect(result?.matchedDurationSec).toBe(305);
  });
});
