import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CACHE_TTL_MS, MusicBrainzClient } from './musicbrainz-client.js';

let dir: string;
let cacheFile: string;
let networkCalls = 0;
const realFetch = globalThis.fetch;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mb-cache-'));
  cacheFile = join(dir, 'mb.json');
  // Any network call in these tests is a bug — the cache must satisfy them.
  // Counted as well as thrown: `fetch<T>` swallows the throw into a transient
  // outcome, so a test asserting only the returned value cannot tell a cache hit
  // from a failed re-query. (It could not: the negative-cache test below passed
  // while making a real call.)
  networkCalls = 0;
  globalThis.fetch = (() => {
    networkCalls += 1;
    throw new Error('unexpected network call');
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Every client in this file injects a no-op sleep (issue #541). The real
 * 1050ms rate limit and 5s 503 backoff made two tests pass in isolation but
 * fail in the full suite — the backoff blew bun's 5s timeout, and the delays
 * shifted the order the fake fetch recorded requests in.
 */
function testClient(): MusicBrainzClient {
  return new MusicBrainzClient(cacheFile, 'test/1.0', { sleep: async () => {} });
}

describe('MusicBrainzClient cache', () => {
  it('loads a persisted cache file and serves an artist hit without any network call', async () => {
    writeFileSync(
      cacheFile,
      JSON.stringify({
        'artist:daft punk': {
          type: 'artist',
          result: { id: 'mbid-1', name: 'Daft Punk', score: 100 },
        },
      }),
    );

    const client = testClient();
    const artist = await client.searchArtist('Daft Punk');

    expect(artist).toEqual({ id: 'mbid-1', name: 'Daft Punk', score: 100 });
  });

  it('caches a negative (null) result too — a cached miss does not re-query', async () => {
    writeFileSync(
      cacheFile,
      // `at` matters: without it this is a legacy entry, which is deliberately
      // dropped on load (see the migration test below). This asserts the
      // behaviour for a miss written by the current code.
      JSON.stringify({
        'artist:nobody at all': { type: 'artist', result: null, at: Date.now() },
      }),
    );

    const client = testClient();
    expect(await client.searchArtist('Nobody At All')).toBeNull();
    expect(networkCalls, 'a cached miss must not re-query').toBe(0);
  });

  it('is case-insensitive on the cache key', async () => {
    writeFileSync(
      cacheFile,
      JSON.stringify({
        'artist:daft punk': {
          type: 'artist',
          result: { id: 'mbid-1', name: 'Daft Punk', score: 100 },
        },
      }),
    );

    const client = testClient();
    // Different casing must resolve to the same cached entry (no network).
    expect((await client.searchArtist('DAFT PUNK'))?.id).toBe('mbid-1');
  });

  it('starts fresh (no throw) when the cache file is corrupt', () => {
    writeFileSync(cacheFile, '{ not valid json');
    expect(() => testClient()).not.toThrow();
  });
});

function mockFetch(body: unknown): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

function mockFetchFail(): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(url);
    return { ok: false, status: 503, json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

describe('MusicBrainzClient getArtistOrigin', () => {
  it('returns the country field when present', async () => {
    const calls = mockFetch({ id: 'mbid-1', country: 'AR' });
    const client = testClient();
    expect(await client.getArtistOrigin('mbid-1')).toEqual({ ok: true, country: 'AR' });
    expect(calls[0]).toContain('/artist/mbid-1');
  });

  it('falls back to a country-typed area iso code', async () => {
    mockFetch({ id: 'mbid-2', area: { type: 'Country', 'iso-3166-1-codes': ['CL'] } });
    const client = testClient();
    expect(await client.getArtistOrigin('mbid-2')).toEqual({ ok: true, country: 'CL' });
  });

  it('normalizes MB special codes to a confirmed miss', async () => {
    mockFetch({ id: 'mbid-3', country: 'XW' });
    const client = testClient();
    expect(await client.getArtistOrigin('mbid-3')).toEqual({ ok: true, country: null });
  });

  // The 503 branch's 5s backoff now runs through the injected no-op sleep, so this
  // needs no extended timeout (issue #541 — it used to be a coin flip against bun's
  // 5000ms default, and a loss left its stub installed for the next test).
  it('reports a transient failure as ok:false and does not cache it', async () => {
    mockFetchFail();
    const client = testClient();
    expect(await client.getArtistOrigin('mbid-4')).toEqual({ ok: false, country: null });
    mockFetch({ id: 'mbid-4', country: 'UY' });
    expect(await client.getArtistOrigin('mbid-4')).toEqual({ ok: true, country: 'UY' });
  });

  it('caches a confirmed answer (second call makes no fetch)', async () => {
    const calls = mockFetch({ id: 'mbid-5', country: 'BR' });
    const client = testClient();
    await client.getArtistOrigin('mbid-5');
    expect(await client.getArtistOrigin('mbid-5')).toEqual({ ok: true, country: 'BR' });
    expect(calls).toHaveLength(1);
  });
});

describe('MusicBrainzClient searchReleaseGroups', () => {
  it('maps release-group hits from artist-credit/primary-type/first-release-date/score', async () => {
    mockFetch({
      'release-groups': [
        {
          id: 'rg-1',
          title: 'Discovery',
          score: 100,
          'primary-type': 'Album',
          'first-release-date': '2001-03-12',
          'artist-credit': [{ name: 'Daft Punk' }],
        },
        {
          id: 'rg-2',
          title: 'Discovery (Deluxe)',
          score: 80,
          'primary-type': 'Album',
          'first-release-date': '2001-03-13',
          'artist-credit': [{ name: 'Daft Punk' }],
        },
      ],
    });
    const client = testClient();
    const hits = await client.searchReleaseGroups('Daft Punk', 'Discovery');

    expect(hits).toEqual([
      {
        id: 'rg-1',
        title: 'Discovery',
        artist: 'Daft Punk',
        primaryType: 'Album',
        firstReleaseDate: '2001-03-12',
        score: 100,
      },
      {
        id: 'rg-2',
        title: 'Discovery (Deluxe)',
        artist: 'Daft Punk',
        primaryType: 'Album',
        firstReleaseDate: '2001-03-13',
        score: 80,
      },
    ]);
  });

  it('caches the result so a repeat lookup does not re-query', async () => {
    const calls = mockFetch({
      'release-groups': [
        {
          id: 'rg-1',
          title: 'Discovery',
          score: 100,
          'artist-credit': [{ name: 'Daft Punk' }],
        },
      ],
    });
    const client = testClient();
    await client.searchReleaseGroups('Daft Punk', 'Discovery');
    await client.searchReleaseGroups('Daft Punk', 'Discovery');
    expect(calls).toHaveLength(1);
  });
});

// Issue #416: a quote/backslash inside a title used to break out of the
// Lucene phrase and corrupt the whole query (encodeURIComponent only
// URL-escapes — Lucene never sees it).
it('escapes Lucene phrase quotes/backslashes in the query', async () => {
  const calls = mockFetch({ 'release-groups': [] });
  const client = testClient();
  await client.searchReleaseGroups('AC\\DC', 'Song "Two" of Three');

  expect(calls).toHaveLength(1);
  const query = decodeURIComponent(new URL(calls[0]).searchParams.get('query') ?? '');
  expect(query).toBe('releasegroup:"Song \\"Two\\" of Three" AND artist:"AC\\\\DC"');
});

// Issue #413: the canonical tracklist behind an MB candidate. Two hops (a
// release group has no tracks), and the release pick is load-bearing.
describe('MusicBrainzClient getCanonicalTracklist', () => {
  function twoHopFetch(releases: unknown, detail: unknown): string[] {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      const body = url.includes('/release?') ? releases : detail;
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;
    return calls;
  }

  it('prefers the Official release with the most tracks, not the first listed', async () => {
    const calls = twoHopFetch(
      {
        releases: [
          { id: 'promo', status: 'Promotion', media: [{ 'track-count': 12 }] },
          { id: 'single-edit', status: 'Official', media: [{ 'track-count': 2 }] },
          { id: 'full', status: 'Official', media: [{ 'track-count': 10 }] },
        ],
      },
      {
        media: [
          {
            tracks: [
              { position: 1, title: 'One', length: 210000 },
              { position: 2, title: 'Two' },
            ],
          },
        ],
      },
    );
    const client = testClient();

    const tracks = await client.getCanonicalTracklist('rg-1');

    // A 2-track official edition would have truncated the tracklist.
    expect(calls[1]).toContain('/release/full');
    expect(tracks).toEqual([
      { position: 1, title: 'One', durationSec: 210 },
      { position: 2, title: 'Two', durationSec: undefined },
    ]);
  });

  it('falls back to non-official releases when none are Official', async () => {
    const calls = twoHopFetch(
      { releases: [{ id: 'boot', status: 'Bootleg', media: [{ 'track-count': 3 }] }] },
      { media: [{ tracks: [{ position: 1, title: 'Only' }] }] },
    );
    const client = testClient();

    expect(await client.getCanonicalTracklist('rg-2')).toHaveLength(1);
    expect(calls[1]).toContain('/release/boot');
  });

  it('returns an empty list (and caches it) when the group has no releases', async () => {
    const calls = twoHopFetch({ releases: [] }, {});
    const client = testClient();

    expect(await client.getCanonicalTracklist('rg-3')).toEqual([]);
    await client.getCanonicalTracklist('rg-3');
    expect(calls).toHaveLength(1); // second call served from cache
  });
});

describe('MusicBrainzClient getArtistDiscogsUrl', () => {
  it('parses a discogs url-relation on an artist', async () => {
    const calls = mockFetch({
      relations: [
        { type: 'official homepage', url: { resource: 'https://example.com' } },
        { type: 'discogs', url: { resource: 'https://www.discogs.com/artist/72872-Aphex-Twin' } },
      ],
    });
    const client = testClient();
    expect(await client.getArtistDiscogsUrl('mbid-1')).toBe(
      'https://www.discogs.com/artist/72872-Aphex-Twin',
    );
    expect(calls[0]).toContain('/artist/mbid-1');
    expect(calls[0]).toContain('inc=url-rels');
  });

  it('returns null when there is no discogs relation', async () => {
    mockFetch({ relations: [{ type: 'official homepage', url: { resource: 'https://x' } }] });
    const client = testClient();
    expect(await client.getArtistDiscogsUrl('mbid-2')).toBeNull();
  });

  it('caches the result so a repeat lookup does not re-query', async () => {
    const calls = mockFetch({
      relations: [{ type: 'discogs', url: { resource: 'https://www.discogs.com/artist/1' } }],
    });
    const client = testClient();
    expect(await client.getArtistDiscogsUrl('mbid-3')).toBe('https://www.discogs.com/artist/1');
    expect(await client.getArtistDiscogsUrl('mbid-3')).toBe('https://www.discogs.com/artist/1');
    expect(calls).toHaveLength(1);
  });
});

describe('MusicBrainzClient injected sleep (issue #541)', () => {
  it('backs off a 503 through the injected sleep instead of a real 5s timer', async () => {
    // Regression: the 5s backoff was a real setTimeout, so under full-suite
    // timing this test sat past bun's 5s default timeout and failed only in
    // the suite (it passed in isolation). The delay must be injectable.
    const slept: number[] = [];
    globalThis.fetch = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    const client = new MusicBrainzClient(cacheFile, 'test/1.0', {
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    const started = Date.now();
    const res = await client.getArtistOrigin('mbid-503');

    expect(res.ok).toBe(false);
    expect(slept).toContain(5000);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('rate-limits through the injected sleep, so request order is deterministic', async () => {
    // Regression: the real 1050ms rate-limit delay shifted the order in which
    // the fake fetch recorded calls, breaking a sibling assertion on calls[1].
    const slept: number[] = [];
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ artists: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new MusicBrainzClient(cacheFile, 'test/1.0', {
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    const started = Date.now();
    await client.searchArtist('a');
    await client.searchArtist('b');

    expect(calls.length).toBe(2);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

/**
 * The cache had no expiry and could not tell "MusicBrainz says there is nothing"
 * from "we could not reach MusicBrainz". One 503 or dropped connection was
 * therefore recorded as "no such entity" forever.
 */
describe('transient failures are never cached', () => {
  function respond(status: number, body: unknown = {}): void {
    globalThis.fetch = (async () => {
      networkCalls += 1;
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
  }

  it('does not remember a 503 — the next call retries', async () => {
    respond(503);
    const client = testClient();
    expect(await client.searchArtist('Someone')).toBeNull();

    // Second call must go back to the network rather than trust the first.
    respond(200, { artists: [{ id: 'mbid-9', name: 'Someone', score: 100 }] });
    expect((await client.searchArtist('Someone'))?.id).toBe('mbid-9');
  });

  it('does not remember a network error either', async () => {
    globalThis.fetch = (() => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const client = testClient();
    expect(await client.searchArtist('Someone')).toBeNull();

    respond(200, { artists: [{ id: 'mbid-9', name: 'Someone', score: 100 }] });
    expect((await client.searchArtist('Someone'))?.id).toBe('mbid-9');
  });

  it('DOES remember a 404 — that is MusicBrainz answering, not failing', async () => {
    respond(404);
    const client = testClient();
    expect(await client.getReleaseGroup('rg-gone')).toBeNull();

    const before = networkCalls;
    expect(await client.getReleaseGroup('rg-gone')).toBeNull();
    expect(networkCalls, 'a confirmed miss is cacheable').toBe(before);
  });
});

describe('cache TTL', () => {
  it('expires an entry once it is older than the TTL', async () => {
    let clock = 1_000_000;
    writeFileSync(
      cacheFile,
      JSON.stringify({
        'artist:daft punk': {
          type: 'artist',
          result: { id: 'mbid-1', name: 'Daft Punk', score: 100 },
          at: clock,
        },
      }),
    );
    const client = new MusicBrainzClient(cacheFile, 'test/1.0', {
      sleep: async () => {},
      now: () => clock,
    });

    expect((await client.searchArtist('Daft Punk'))?.id).toBe('mbid-1');
    expect(networkCalls).toBe(0);

    clock += CACHE_TTL_MS + 1;
    await client.searchArtist('Daft Punk');
    expect(networkCalls, 'a stale entry must be re-fetched').toBe(1);
  });
});

describe('legacy cache migration', () => {
  it('drops a legacy MISS — it may be a recorded failure, not a real absence', async () => {
    // No `at`: written before transient and confirmed were distinguishable.
    writeFileSync(cacheFile, JSON.stringify({ 'artist:ghost': { type: 'artist', result: null } }));
    const client = testClient();
    await client.searchArtist('Ghost');
    expect(networkCalls, 'a legacy miss must not be trusted').toBe(1);
  });

  it('keeps a legacy HIT — real data is worth keeping, and re-fetching costs 1 req/sec', async () => {
    writeFileSync(
      cacheFile,
      JSON.stringify({
        'artist:daft punk': {
          type: 'artist',
          result: { id: 'mbid-1', name: 'Daft Punk', score: 100 },
        },
      }),
    );
    const client = testClient();
    expect((await client.searchArtist('Daft Punk'))?.id).toBe('mbid-1');
    expect(networkCalls, 'a legacy hit must still serve from cache').toBe(0);
  });
});
