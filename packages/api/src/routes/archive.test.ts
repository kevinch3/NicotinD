import { describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import { archiveRoutes } from './archive.js';
import { ArchiveSearchService } from '../services/archive-search.service.js';
import type { PluginRegistry } from '../services/plugins/registry.js';

const SEARCH_BODY = {
  response: {
    docs: [
      { identifier: 'foo-123', title: 'Foo', creator: ['Bar'], year: 2016 },
      { identifier: 'baz-456', title: ['Baz'], creator: 'Qux' },
    ],
  },
};

function fetchReturning(body: unknown, ok = true): { fn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fn = mock(async (url: string) => {
    calls.push(url);
    return { ok, status: ok ? 200 : 500, json: async () => body };
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function fakePlugins(enabled: boolean): PluginRegistry {
  return { isEnabled: (id: string) => id === 'archive' && enabled } as unknown as PluginRegistry;
}

function makeApp(opts: { enabled: boolean; fetchFn: typeof fetch }) {
  const app = new Hono<AuthEnv>();
  app.use('*', (c, next) => {
    c.set('user', { sub: 'user1', role: 'user', iat: 0, exp: 9999999999 });
    return next();
  });
  app.route(
    '/api/archive',
    archiveRoutes({
      search: new ArchiveSearchService(opts.fetchFn),
      plugins: fakePlugins(opts.enabled),
    }),
  );
  return app;
}

describe('ArchiveSearchService', () => {
  it('maps advancedsearch docs to candidates (string|array creator/title, year)', async () => {
    const { fn, calls } = fetchReturning(SEARCH_BODY);
    const svc = new ArchiveSearchService(fn);
    const out = await svc.search('foo');

    expect(out).toEqual([
      {
        identifier: 'foo-123',
        title: 'Foo',
        creator: 'Bar',
        year: '2016',
        detailsUrl: 'https://archive.org/details/foo-123',
      },
      {
        identifier: 'baz-456',
        title: 'Baz',
        creator: 'Qux',
        year: null,
        detailsUrl: 'https://archive.org/details/baz-456',
      },
    ]);
    // Constrains to audio + requests the json output.
    expect(calls[0]).toContain('mediatype%3Aaudio');
    expect(calls[0]).toContain('output=json');
  });

  it('free-text search targets the title/creator fields with a quoted phrase', async () => {
    const { fn, calls } = fetchReturning(SEARCH_BODY);
    await new ArchiveSearchService(fn).search('Zara Larsson');
    const decoded = decodeURIComponent(calls[0]!).replace(/\+/g, ' ');
    expect(decoded).toContain(
      '(title:("Zara Larsson") OR creator:("Zara Larsson")) AND mediatype:audio',
    );
  });

  it('searchAlbum targets creator (artist) and title (album)', async () => {
    const { fn, calls } = fetchReturning(SEARCH_BODY);
    await new ArchiveSearchService(fn).searchAlbum('Ráfaga', 'Una Cerveza');
    const decoded = decodeURIComponent(calls[0]!).replace(/\+/g, ' ');
    expect(decoded).toContain('creator:("Ráfaga") AND title:("Una Cerveza") AND mediatype:audio');
  });

  it('escapes embedded quotes in a term', async () => {
    const { fn, calls } = fetchReturning(SEARCH_BODY);
    await new ArchiveSearchService(fn).searchAlbum('AC"DC', '');
    const decoded = decodeURIComponent(calls[0]!).replace(/\+/g, ' ');
    expect(decoded).toContain('creator:("AC\\"DC")');
  });

  it('returns [] (not an error) for an empty docs array', async () => {
    const { fn } = fetchReturning({ response: { docs: [] } });
    expect(await new ArchiveSearchService(fn).search('foo')).toEqual([]);
  });

  it('retries once then throws when archive.org keeps failing', async () => {
    const { fn, calls } = fetchReturning({}, false);
    await expect(new ArchiveSearchService(fn).search('foo')).rejects.toThrow();
    expect(calls).toHaveLength(2); // initial attempt + one retry
  });

  it('recovers when the retry succeeds', async () => {
    let n = 0;
    const fn = mock(async () => {
      n++;
      return n === 1
        ? { ok: false, status: 503, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => SEARCH_BODY };
    }) as unknown as typeof fetch;
    const out = await new ArchiveSearchService(fn).search('foo');
    expect(out).toHaveLength(2);
    expect(n).toBe(2);
  });
});

describe('archive routes', () => {
  it('503s when the archive plugin is disabled', async () => {
    const { fn } = fetchReturning(SEARCH_BODY);
    const app = makeApp({ enabled: false, fetchFn: fn });
    const res = await app.request('/api/archive/search?q=foo');
    expect(res.status).toBe(503);
  });

  it('returns candidates for a free-text query when enabled', async () => {
    const { fn } = fetchReturning(SEARCH_BODY);
    const app = makeApp({ enabled: true, fetchFn: fn });
    const res = await app.request('/api/archive/search?q=foo');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: unknown[] };
    expect(body.candidates).toHaveLength(2);
  });

  it('400s when neither q nor artist/album is provided', async () => {
    const { fn } = fetchReturning(SEARCH_BODY);
    const app = makeApp({ enabled: true, fetchFn: fn });
    const res = await app.request('/api/archive/search');
    expect(res.status).toBe(400);
  });

  it('503s with an archive.org message when the upstream keeps failing', async () => {
    const { fn } = fetchReturning({}, false);
    const app = makeApp({ enabled: true, fetchFn: fn });
    const res = await app.request('/api/archive/search?q=foo');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/archive\.org/i);
  });
});
