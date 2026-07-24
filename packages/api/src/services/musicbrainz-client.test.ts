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
        { type: 'license', url: { resource: 'https://creativecommons.org/publicdomain/zero/1.0/' } },
      ],
    });
    const client = new MusicBrainzClient(cacheFile, 'test/1.0');
    expect(await client.getLicence({ mbReleaseId: 'rel-9' })).toBe('cc0');
    expect(await client.getLicence({ mbReleaseId: 'rel-9' })).toBe('cc0');
    expect(calls).toHaveLength(1);
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
