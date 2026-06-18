import { describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import { archiveRoutes } from './archive.js';
import {
  ArchiveSearchService,
  archiveDedupeKey,
  countArchiveTracks,
} from '../services/archive-search.service.js';
import type { PluginRegistry } from '../services/plugins/registry.js';

const SEARCH_BODY = {
  response: {
    docs: [
      { identifier: 'foo-123', title: 'Foo', creator: ['Bar'], year: 2016 },
      { identifier: 'baz-456', title: ['Baz'], creator: 'Qux' },
    ],
  },
};

// Default per-item metadata: a 3-track MP3 album, so search candidates survive the
// track-count enrichment (which drops items proven to have no audio).
const DEFAULT_META_FILES = [
  { name: 't1.mp3', format: 'VBR MP3' },
  { name: 't2.mp3', format: 'VBR MP3' },
  { name: 't3.mp3', format: 'VBR MP3' },
];

// URL-aware mock: advancedsearch calls return `body`; the per-item `/metadata/<id>`
// enrichment calls return `metaFiles` (overridable per identifier).
function fetchReturning(
  body: unknown,
  ok = true,
  metaByIdentifier: Record<string, { name: string; format?: string }[]> = {},
): { fn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fn = mock(async (url: string) => {
    calls.push(url);
    if (url.includes('/metadata/')) {
      const id = decodeURIComponent(url.split('/metadata/')[1] ?? '');
      return {
        ok: true,
        status: 200,
        json: async () => ({ files: metaByIdentifier[id] ?? DEFAULT_META_FILES }),
      };
    }
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
        trackCount: 3,
        kind: 'album',
      },
      {
        identifier: 'baz-456',
        title: 'Baz',
        creator: 'Qux',
        year: null,
        detailsUrl: 'https://archive.org/details/baz-456',
        trackCount: 3,
        kind: 'album',
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

  it('excludes non-music collections (audiobooks/radio/podcasts)', async () => {
    const { fn, calls } = fetchReturning(SEARCH_BODY);
    await new ArchiveSearchService(fn).search('Shaggy');
    const decoded = decodeURIComponent(calls[0]!).replace(/\+/g, ' ');
    expect(decoded).toContain('-collection:(librivoxaudio OR');
    expect(decoded).toContain('oldtimeradio');
    expect(decoded).toContain('podcasts');
  });

  it('sorts by downloads (popularity) descending', async () => {
    const { fn, calls } = fetchReturning(SEARCH_BODY);
    await new ArchiveSearchService(fn).search('foo');
    const decoded = decodeURIComponent(calls[0]!).replace(/\+/g, ' ');
    expect(decoded).toContain('sort[]=downloads desc');
  });

  it('dedupes format/year variants of the same release (keeps the first)', async () => {
    const { fn } = fetchReturning({
      response: {
        docs: [
          { identifier: 'a', title: 'Porfiado', creator: ['El Cuarteto De Nos'], year: 2012 },
          {
            identifier: 'b',
            title: 'El Cuarteto de Nos - Porfiado (2012) [FLAC]',
            creator: 'El Cuarteto de Nos',
          },
          { identifier: 'c', title: 'A Different Album', creator: ['El Cuarteto de Nos'] },
        ],
      },
    });
    const out = await new ArchiveSearchService(fn).search('cuarteto');
    expect(out.map((c) => c.identifier)).toEqual(['a', 'c']);
  });

  it('recovers when the retry succeeds', async () => {
    let searchAttempts = 0;
    const fn = mock(async (url: string) => {
      if (url.includes('/metadata/')) {
        return { ok: true, status: 200, json: async () => ({ files: DEFAULT_META_FILES }) };
      }
      searchAttempts++;
      return searchAttempts === 1
        ? { ok: false, status: 503, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => SEARCH_BODY };
    }) as unknown as typeof fetch;
    const out = await new ArchiveSearchService(fn).search('foo');
    expect(out).toHaveLength(2);
    expect(searchAttempts).toBe(2);
  });

  it('excludes the broader audiobook/lecture/live-tape collections too', async () => {
    const { fn, calls } = fetchReturning(SEARCH_BODY);
    await new ArchiveSearchService(fn).search('Shaggy');
    const decoded = decodeURIComponent(calls[0]!).replace(/\+/g, ' ');
    expect(decoded).toContain('audiobooksandpoetry');
    expect(decoded).toContain('etree'); // live-concert archive that floods music queries
  });

  it('annotates each item with track count + kind (album/single)', async () => {
    const { fn } = fetchReturning(SEARCH_BODY, true, {
      'foo-123': [{ name: 'only.flac', format: 'FLAC' }], // single
      'baz-456': [
        { name: 'a.mp3', format: 'VBR MP3' },
        { name: 'b.mp3', format: 'VBR MP3' },
      ], // album
    });
    const out = await new ArchiveSearchService(fn).search('foo');
    expect(out.find((c) => c.identifier === 'foo-123')).toMatchObject({ trackCount: 1, kind: 'single' });
    expect(out.find((c) => c.identifier === 'baz-456')).toMatchObject({ trackCount: 2, kind: 'album' });
  });

  it('drops items whose metadata proves they have no audio files', async () => {
    const { fn } = fetchReturning(SEARCH_BODY, true, {
      'foo-123': [{ name: 'cover.jpg' }, { name: 'meta.xml' }], // no audio → dropped
      'baz-456': DEFAULT_META_FILES,
    });
    const out = await new ArchiveSearchService(fn).search('foo');
    expect(out.map((c) => c.identifier)).toEqual(['baz-456']);
  });
});

describe('countArchiveTracks', () => {
  it('counts the largest single-format audio group (FLAC+MP3 dual-encode counts once)', () => {
    expect(
      countArchiveTracks([
        { name: '1.flac', format: 'FLAC' },
        { name: '2.flac', format: 'FLAC' },
        { name: '1.mp3', format: 'VBR MP3' },
        { name: '2.mp3', format: 'VBR MP3' },
        { name: 'cover.jpg' },
      ]),
    ).toBe(2);
  });
  it('returns 0 when there are no audio files', () => {
    expect(countArchiveTracks([{ name: 'reader.txt' }, { name: 'art.png' }])).toBe(0);
  });
});

describe('archiveDedupeKey', () => {
  it('collapses diacritics, brackets, year and format noise to a sorted token set', () => {
    const a = archiveDedupeKey({ creator: 'El Cuarteto De Nos', title: 'Porfiado' });
    const b = archiveDedupeKey({
      creator: 'El Cuarteto de Nos',
      title: 'El Cuarteto de Nos - Porfiado (2012) [FLAC]',
    });
    expect(a).toBe(b);
    expect(a).toBe('cuarteto de el nos porfiado');
  });

  it('keeps genuinely different releases distinct', () => {
    const a = archiveDedupeKey({ creator: 'Shaggy', title: 'Hot Shot' });
    const b = archiveDedupeKey({ creator: 'Shaggy', title: 'Boombastic' });
    expect(a).not.toBe(b);
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
