import { describe, expect, it } from 'bun:test';
import { validatePluginManifest, type PluginHostContext } from '@nicotind/core';
import { DiscogsPlugin } from './index.js';
import type { DiscogsRef } from './matching.js';

interface Route {
  match: string;
  status?: number;
  body: unknown;
}

/** A fetch fake mapping URL substrings to JSON bodies (200 unless overridden). */
function routeFetch(routes: Route[]): { fetchFn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    calls.push(url);
    const route = routes.find((r) => url.includes(r.match));
    const status = route?.status ?? (route ? 200 : 404);
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => route?.body ?? {},
      headers: { get: () => null },
    };
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const noWait = { now: () => 0, sleep: async () => {} };

function makePlugin(over: Partial<ConstructorParameters<typeof DiscogsPlugin>[0]> = {}, deps = {}) {
  return new DiscogsPlugin(
    { consumerKey: 'KEY', consumerSecret: 'SECRET', ...over },
    { ...noWait, ...deps },
  );
}

describe('DiscogsPlugin manifest', () => {
  it('is a valid, consent-gated, default-off metadata/genre plugin', () => {
    const plugin = makePlugin();
    expect(validatePluginManifest(plugin.manifest)).toEqual([]);
    expect(plugin.manifest.kind).toBe('metadata');
    expect(plugin.manifest.capabilities).toEqual(['genre']);
    expect(plugin.manifest.defaultEnabled).toBe(false);
    expect(plugin.manifest.compliance?.requiresConsent).toBe(true);
  });
});

describe('DiscogsPlugin availability', () => {
  it('is unavailable without credentials, available with both', async () => {
    expect(await new DiscogsPlugin({ consumerKey: '', consumerSecret: '' }).isAvailable()).toBe(
      false,
    );
    expect(await new DiscogsPlugin({ consumerKey: 'k', consumerSecret: '' }).isAvailable()).toBe(
      false,
    );
    expect(await new DiscogsPlugin({ consumerKey: 'k', consumerSecret: 's' }).isAvailable()).toBe(
      true,
    );
  });

  it('picks up credentials merged from init config', async () => {
    const plugin = new DiscogsPlugin({ consumerKey: '', consumerSecret: '' });
    expect(await plugin.isAvailable()).toBe(false);
    await plugin.init({
      config: { consumerKey: 'k', consumerSecret: 's' },
    } as unknown as PluginHostContext);
    expect(await plugin.isAvailable()).toBe(true);
  });
});

describe('DiscogsPlugin.fetchGenres — name search', () => {
  const query = { artist: 'José Larralde', album: 'Herencia Pa un Hijo Gaucho' };

  it('resolves genres + styles for a corroborated release', async () => {
    const { fetchFn } = routeFetch([
      {
        match: '/database/search',
        body: {
          results: [
            { id: 22, type: 'release', title: 'José Larralde - Herencia Pa un Hijo Gaucho' },
          ],
        },
      },
      {
        match: '/releases/22',
        body: { id: 22, genres: ['Folk, World, & Country'], styles: ['Chamamé'] },
      },
    ]);
    const plugin = makePlugin({}, { fetchFn });
    expect(await plugin.genre.fetchGenres(query)).toEqual({
      genres: ['Folk, World, & Country', 'Chamamé'],
      source: 'discogs',
      confidence: 1,
    });
  });

  it('returns null when no search hit corroborates', async () => {
    const { fetchFn } = routeFetch([
      {
        match: '/database/search',
        body: { results: [{ id: 1, type: 'release', title: 'Someone Else - Other' }] },
      },
    ]);
    const plugin = makePlugin({}, { fetchFn });
    expect(await plugin.genre.fetchGenres(query)).toBeNull();
  });

  it('returns null when the client is unconfigured', async () => {
    const plugin = new DiscogsPlugin({ consumerKey: '', consumerSecret: '' });
    expect(await plugin.genre.fetchGenres(query)).toBeNull();
  });
});

describe('DiscogsPlugin.fetchGenres — MBID-first', () => {
  it('resolves via the injected MBID resolver and skips the name search', async () => {
    const { fetchFn, calls } = routeFetch([
      { match: '/masters/96559', body: { id: 96559, genres: ['Electronic'], styles: ['House'] } },
    ]);
    const resolveDiscogsRef = async (): Promise<DiscogsRef> => ({ kind: 'master', id: 96559 });
    const plugin = makePlugin({}, { fetchFn, resolveDiscogsRef });
    const result = await plugin.genre.fetchGenres({
      artist: 'Someone',
      album: 'Some Album',
      mbid: { releaseGroup: 'mbid-rg' },
    });
    expect(result).toEqual({
      genres: ['Electronic', 'House'],
      source: 'discogs',
      confidence: 0.95,
    });
    // MBID short-circuits: no /database/search call.
    expect(calls.some((u) => u.includes('/database/search'))).toBe(false);
  });

  it('falls back to name search when the MBID resolver finds nothing', async () => {
    const { fetchFn, calls } = routeFetch([
      {
        match: '/database/search',
        body: { results: [{ id: 5, type: 'release', title: 'Someone - Some Album' }] },
      },
      { match: '/releases/5', body: { id: 5, genres: ['Pop'] } },
    ]);
    const resolveDiscogsRef = async (): Promise<DiscogsRef | null> => null;
    const plugin = makePlugin({}, { fetchFn, resolveDiscogsRef });
    const result = await plugin.genre.fetchGenres({
      artist: 'Someone',
      album: 'Some Album',
      mbid: { release: 'mbid-rel' },
    });
    expect(result?.genres).toEqual(['Pop']);
    expect(calls.some((u) => u.includes('/database/search'))).toBe(true);
  });
});
