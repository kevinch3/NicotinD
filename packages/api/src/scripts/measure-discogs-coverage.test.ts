import { describe, expect, it } from 'bun:test';
import {
  foldArtist,
  foldTitle,
  normalizeGenreList,
  buildSearchUrl,
  buildEntityUrl,
  buildMbReleaseGroupUrl,
  parseDiscogsRef,
  extractDiscogsRelationUrl,
  mapReleaseGenres,
  scoreHit,
  pickBestHit,
  tallyCohort,
  renderReport,
  DiscogsCoverageProbe,
  USER_AGENT,
  type CaseResult,
  type DiscogsSearchHit,
} from './measure-discogs-coverage.js';

interface FakeRoute {
  match: string;
  status?: number;
  body: unknown;
  remaining?: string;
}

/** A fetch fake: substring-routed responses + a per-URL call counter + header log. */
function routeFetch(
  routes: FakeRoute[] | ((url: string, hitCount: number) => FakeRoute | undefined),
): { fetchFn: typeof fetch; calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const counts = new Map<string, number>();
  const fetchFn = (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const n = (counts.get(url) ?? 0) + 1;
    counts.set(url, n);
    const route =
      typeof routes === 'function' ? routes(url, n) : routes.find((r) => url.includes(r.match));
    const status = route?.status ?? (route ? 200 : 404);
    return {
      status,
      json: async () => route?.body ?? {},
      headers: {
        get: (h: string) =>
          h.toLowerCase() === 'x-discogs-ratelimit-remaining' ? (route?.remaining ?? null) : null,
      },
    };
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const noWait = { sleep: async () => {}, now: () => 0 };
const auth = { consumerKey: 'KEY', consumerSecret: 'SECRET' };

describe('pure normalization', () => {
  it('folds accents; artist keeps punctuation, title drops it', () => {
    expect(foldArtist('José Larralde')).toBe('jose larralde');
    expect(foldTitle('Tú Crees en Mí!')).toBe('tu crees en mi');
  });

  it('normalizeGenreList trims, drops empties, de-duplicates', () => {
    expect(normalizeGenreList(['Folk', ' Folk ', '', 'Chamamé'])).toEqual(['Folk', 'Chamamé']);
    expect(normalizeGenreList(undefined)).toEqual([]);
  });
});

describe('pure URL building', () => {
  it('builds a Discogs release search URL', () => {
    expect(buildSearchUrl('https://api.discogs.com', { artist: 'A B', album: 'C D' })).toBe(
      'https://api.discogs.com/database/search?artist=A+B&release_title=C+D&type=release&per_page=10',
    );
  });

  it('builds entity + MB release-group URLs', () => {
    expect(buildEntityUrl('https://api.discogs.com', { kind: 'master', id: 5 })).toBe(
      'https://api.discogs.com/masters/5',
    );
    expect(buildEntityUrl('https://api.discogs.com', { kind: 'release', id: 9 })).toBe(
      'https://api.discogs.com/releases/9',
    );
    expect(buildMbReleaseGroupUrl('https://mb/ws/2', 'mbid-1')).toBe(
      'https://mb/ws/2/release-group/mbid-1?inc=url-rels&fmt=json',
    );
  });
});

describe('pure ref parsing', () => {
  it('parses Discogs entity URLs (human + API shapes)', () => {
    expect(parseDiscogsRef('https://www.discogs.com/release/249504-x')).toEqual({
      kind: 'release',
      id: 249504,
    });
    expect(parseDiscogsRef('https://api.discogs.com/masters/96559')).toEqual({
      kind: 'master',
      id: 96559,
    });
    expect(parseDiscogsRef('https://www.discogs.com/artist/1')).toBeNull();
  });

  it('extracts the discogs relation from a MB release-group', () => {
    expect(
      extractDiscogsRelationUrl({
        relations: [
          { type: 'wikidata', url: { resource: 'https://www.wikidata.org/x' } },
          { type: 'discogs', url: { resource: 'https://www.discogs.com/master/96559' } },
        ],
      }),
    ).toBe('https://www.discogs.com/master/96559');
    expect(extractDiscogsRelationUrl({ relations: [] })).toBeNull();
  });
});

describe('pure response mapping + scoring', () => {
  const hit = (over: Partial<DiscogsSearchHit>): DiscogsSearchHit => ({
    id: 1,
    type: 'release',
    title: 'A - B',
    ...over,
  });

  it('maps + de-duplicates genres and styles', () => {
    expect(
      mapReleaseGenres({ genres: ['Folk', 'Folk'], styles: ['Chamamé', ' Folclore '] }),
    ).toEqual({ genres: ['Folk'], styles: ['Chamamé', 'Folclore'] });
  });

  it('scores both-halves-required (right artist, wrong album = 0)', () => {
    const q = { artist: 'José Larralde', album: 'Herencia' };
    expect(scoreHit(q, hit({ title: 'José Larralde - Herencia' }))).toBe(1);
    expect(scoreHit(q, hit({ title: 'José Larralde - Other' }))).toBe(0);
    expect(scoreHit(q, hit({ title: 'Someone - Herencia' }))).toBe(0);
  });

  it('pickBestHit rejects the same-name false match and prefers a master', () => {
    const q = { artist: 'Emilia', album: 'Tú Crees en Mí' };
    // Swedish Emilia (wrong album) is rejected; the right release wins.
    expect(
      pickBestHit(q, [
        hit({ id: 11, title: 'Emilia - Big Big World' }),
        hit({ id: 22, title: 'Emilia - Tú Crees en Mí' }),
      ]),
    ).toEqual({ ref: { kind: 'release', id: 22 }, confidence: 1 });
    // Master beats release on a tie.
    expect(
      pickBestHit({ artist: 'Daft Punk', album: 'Discovery' }, [
        hit({ id: 1, type: 'release', title: 'Daft Punk - Discovery' }),
        hit({ id: 2, type: 'master', title: 'Daft Punk - Discovery' }),
      ])?.ref,
    ).toEqual({ kind: 'master', id: 2 });
    // Nothing corroborates → null.
    expect(pickBestHit(q, [hit({ id: 11, title: 'Emilia - Big Big World' })])).toBeNull();
  });
});

describe('tallyCohort + renderReport', () => {
  const cases: CaseResult[] = [
    { artist: 'A', album: 'x', via: 'name', genres: ['Folk'], styles: ['Chamamé'], requests: 2 },
    { artist: 'B', album: 'y', via: 'mbid', genres: [], styles: ['House'], requests: 2 },
    { artist: 'C', album: 'z', via: null, genres: [], styles: [], requests: 1 },
  ];

  it('tallies the residual gap correctly', () => {
    expect(tallyCohort(cases)).toEqual({
      residual: 3,
      resolvedByGenres: 1,
      resolvedByStyles: 2,
      resolvedByEither: 2,
    });
  });

  it('renders a markdown report with the cohort table', () => {
    const report = renderReport({
      tally: tallyCohort(cases),
      cases,
      named: [cases[0]!],
      totalRequests: 5,
      elapsedMs: 3200,
    });
    expect(report).toContain('| Songs genre-less after A1 (the residual gap) | 3 |');
    expect(report).toContain('resolved by Discogs release styles | 2 (67%)');
    expect(report).toContain('5 requests');
    expect(report).toContain('### Named cases');
    expect(report).toContain('unresolved'); // case C resolved nothing
  });
});

describe('DiscogsCoverageProbe (injected fetch)', () => {
  it('resolves via name search when there is no MBID', async () => {
    const { fetchFn, calls } = routeFetch([
      {
        match: '/database/search',
        body: { results: [{ id: 22, type: 'release', title: 'José Larralde - Herencia' }] },
      },
      { match: '/releases/22', body: { genres: ['Folk, World, & Country'], styles: ['Chamamé'] } },
    ]);
    const probe = new DiscogsCoverageProbe({ auth, fetchFn, ...noWait });
    const result = await probe.probeCase({
      artist: 'José Larralde',
      album: 'Herencia',
      albumMbid: null,
    });
    expect(result.via).toBe('name');
    expect(result.genres).toEqual(['Folk, World, & Country']);
    expect(result.styles).toEqual(['Chamamé']);
    expect(result.requests).toBe(2);
    // User-Agent on every request; Discogs auth header on the Discogs calls.
    for (const c of calls) expect(c.headers['User-Agent']).toBe(USER_AGENT);
    expect(calls.every((c) => c.headers['Authorization']?.startsWith('Discogs key='))).toBe(true);
  });

  it('resolves MBID-first and skips the name search', async () => {
    const { fetchFn, calls } = routeFetch([
      {
        match: '/release-group/',
        body: {
          relations: [
            { type: 'discogs', url: { resource: 'https://www.discogs.com/master/96559' } },
          ],
        },
      },
      { match: '/masters/96559', body: { genres: ['Electronic'], styles: ['House'] } },
    ]);
    const probe = new DiscogsCoverageProbe({ auth, fetchFn, ...noWait });
    const result = await probe.probeCase({ artist: 'X', album: 'Y', albumMbid: 'mbid-1' });
    expect(result.via).toBe('mbid');
    expect(result.genres).toEqual(['Electronic']);
    expect(result.styles).toEqual(['House']);
    expect(calls.some((c) => c.url.includes('/database/search'))).toBe(false);
  });

  it('retries a transient 5xx then succeeds, counting the extra request', async () => {
    const { fetchFn } = routeFetch((url, n) => {
      if (url.includes('/database/search'))
        return { match: '', body: { results: [{ id: 5, type: 'release', title: 'X - Y' }] } };
      if (url.includes('/releases/5'))
        return n === 1
          ? { match: '', status: 503, body: { message: 'Query time exceeded' } }
          : { match: '', body: { genres: ['Pop'] } };
      return undefined;
    });
    const probe = new DiscogsCoverageProbe({ auth, fetchFn, ...noWait });
    const result = await probe.probeCase({ artist: 'X', album: 'Y', albumMbid: null });
    expect(result.genres).toEqual(['Pop']);
    expect(result.requests).toBe(3); // search + (503 retry) release
  });

  it('reports an unresolved case when nothing corroborates', async () => {
    const { fetchFn } = routeFetch([
      {
        match: '/database/search',
        body: { results: [{ id: 9, type: 'release', title: 'Someone - Else' }] },
      },
    ]);
    const probe = new DiscogsCoverageProbe({ auth, fetchFn, ...noWait });
    const result = await probe.probeCase({ artist: 'X', album: 'Y', albumMbid: null });
    expect(result.via).toBeNull();
    expect(result.genres).toEqual([]);
  });
});
