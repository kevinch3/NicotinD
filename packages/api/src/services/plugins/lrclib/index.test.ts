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
});
