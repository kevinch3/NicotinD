import { describe, expect, it, mock } from 'bun:test';
import { validatePluginManifest } from '@nicotind/core';
import { LrclibPlugin } from './index.js';

/** A fetch fake that maps URL substrings to {status, body}. */
function routeFetch(routes: Array<{ match: string; status: number; body: unknown }>): typeof fetch {
  return mock(async (url: string) => {
    const route = routes.find((r) => url.includes(r.match));
    if (!route) return { ok: false, status: 500, json: async () => ({}) };
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      json: async () => route.body,
    };
  }) as unknown as typeof fetch;
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
