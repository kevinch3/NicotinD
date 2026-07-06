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
