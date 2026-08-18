import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MusicBrainzClient } from './musicbrainz-client.js';

let dir: string;
let cacheFile: string;
const realFetch = globalThis.fetch;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mb-cache-'));
  cacheFile = join(dir, 'mb.json');
  // Any network call in these tests is a bug — the cache must satisfy them.
  globalThis.fetch = (() => {
    throw new Error('unexpected network call');
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

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

    const client = new MusicBrainzClient(cacheFile, 'test/1.0');
    const artist = await client.searchArtist('Daft Punk');

    expect(artist).toEqual({ id: 'mbid-1', name: 'Daft Punk', score: 100 });
  });

  it('caches a negative (null) result too — a cached miss does not re-query', async () => {
    writeFileSync(
      cacheFile,
      JSON.stringify({ 'artist:nobody at all': { type: 'artist', result: null } }),
    );

    const client = new MusicBrainzClient(cacheFile, 'test/1.0');
    expect(await client.searchArtist('Nobody At All')).toBeNull();
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

    const client = new MusicBrainzClient(cacheFile, 'test/1.0');
    // Different casing must resolve to the same cached entry (no network).
    expect((await client.searchArtist('DAFT PUNK'))?.id).toBe('mbid-1');
  });

  it('starts fresh (no throw) when the cache file is corrupt', () => {
    writeFileSync(cacheFile, '{ not valid json');
    expect(() => new MusicBrainzClient(cacheFile, 'test/1.0')).not.toThrow();
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

describe('MusicBrainzClient getLicence', () => {
  it('parses a license url-relation on a recording into a canonical code', async () => {
    const calls = mockFetch({
      relations: [
        { type: 'producer', url: { resource: 'https://example.com/x' } },
        { type: 'license', url: { resource: 'https://creativecommons.org/licenses/by-sa/4.0/' } },
      ],
    });
    const client = new MusicBrainzClient(cacheFile, 'test/1.0');
    expect(await client.getLicence({ mbRecordingId: 'rec-1' })).toBe('cc-by-sa');
    expect(calls[0]).toContain('/recording/rec-1');
    expect(calls[0]).toContain('inc=url-rels');
  });

  it('returns null when there is no license relation', async () => {
    mockFetch({ relations: [{ type: 'stream', url: { resource: 'https://x' } }] });
    const client = new MusicBrainzClient(cacheFile, 'test/1.0');
    expect(await client.getLicence({ mbRecordingId: 'rec-2' })).toBeNull();
  });

  it('returns null (no network) when neither id nor artist+title is given', async () => {
    // fetch stays the throwing default from beforeEach — it must not be called.
    const client = new MusicBrainzClient(cacheFile, 'test/1.0');
    expect(await client.getLicence({})).toBeNull();
  });

  it('caches the result so a repeat lookup does not re-query', async () => {
    const calls = mockFetch({
      relations: [
        {
          type: 'license',
          url: { resource: 'https://creativecommons.org/publicdomain/zero/1.0/' },
        },
      ],
    });
    const client = new MusicBrainzClient(cacheFile, 'test/1.0');
    expect(await client.getLicence({ mbReleaseId: 'rel-9' })).toBe('cc0');
    expect(await client.getLicence({ mbReleaseId: 'rel-9' })).toBe('cc0');
    expect(calls).toHaveLength(1);
  });
});

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
    const client = new MusicBrainzClient(cacheFile, 'test/1.0');
    expect(await client.getArtistOrigin('mbid-1')).toEqual({ ok: true, country: 'AR' });
    expect(calls[0]).toContain('/artist/mbid-1');
  });

  it('falls back to a country-typed area iso code', async () => {
    mockFetch({ id: 'mbid-2', area: { type: 'Country', 'iso-3166-1-codes': ['CL'] } });
    const client = new MusicBrainzClient(cacheFile, 'test/1.0');
    expect(await client.getArtistOrigin('mbid-2')).toEqual({ ok: true, country: 'CL' });
  });

  it('normalizes MB special codes to a confirmed miss', async () => {
    mockFetch({ id: 'mbid-3', country: 'XW' });
    const client = new MusicBrainzClient(cacheFile, 'test/1.0');
    expect(await client.getArtistOrigin('mbid-3')).toEqual({ ok: true, country: null });
  });

  it('reports a transient failure as ok:false and does not cache it', async () => {
    mockFetchFail();
    const client = new MusicBrainzClient(cacheFile, 'test/1.0');
    expect(await client.getArtistOrigin('mbid-4')).toEqual({ ok: false, country: null });
    mockFetch({ id: 'mbid-4', country: 'UY' });
    expect(await client.getArtistOrigin('mbid-4')).toEqual({ ok: true, country: 'UY' });
  });

  it('caches a confirmed answer (second call makes no fetch)', async () => {
    const calls = mockFetch({ id: 'mbid-5', country: 'BR' });
    const client = new MusicBrainzClient(cacheFile, 'test/1.0');
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
    const client = new MusicBrainzClient(cacheFile, 'test/1.0');
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
    const client = new MusicBrainzClient(cacheFile, 'test/1.0');
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
  const client = new MusicBrainzClient(cacheFile, 'test/1.0');
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
    const client = new MusicBrainzClient(cacheFile, 'test/1.0');

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
    const client = new MusicBrainzClient(cacheFile, 'test/1.0');

    expect(await client.getCanonicalTracklist('rg-2')).toHaveLength(1);
    expect(calls[1]).toContain('/release/boot');
  });

  it('returns an empty list (and caches it) when the group has no releases', async () => {
    const calls = twoHopFetch({ releases: [] }, {});
    const client = new MusicBrainzClient(cacheFile, 'test/1.0');

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
    const client = new MusicBrainzClient(cacheFile, 'test/1.0');
    expect(await client.getArtistDiscogsUrl('mbid-1')).toBe(
      'https://www.discogs.com/artist/72872-Aphex-Twin',
    );
    expect(calls[0]).toContain('/artist/mbid-1');
    expect(calls[0]).toContain('inc=url-rels');
  });

  it('returns null when there is no discogs relation', async () => {
    mockFetch({ relations: [{ type: 'official homepage', url: { resource: 'https://x' } }] });
    const client = new MusicBrainzClient(cacheFile, 'test/1.0');
    expect(await client.getArtistDiscogsUrl('mbid-2')).toBeNull();
  });

  it('caches the result so a repeat lookup does not re-query', async () => {
    const calls = mockFetch({
      relations: [{ type: 'discogs', url: { resource: 'https://www.discogs.com/artist/1' } }],
    });
    const client = new MusicBrainzClient(cacheFile, 'test/1.0');
    expect(await client.getArtistDiscogsUrl('mbid-3')).toBe('https://www.discogs.com/artist/1');
    expect(await client.getArtistDiscogsUrl('mbid-3')).toBe('https://www.discogs.com/artist/1');
    expect(calls).toHaveLength(1);
  });
});
