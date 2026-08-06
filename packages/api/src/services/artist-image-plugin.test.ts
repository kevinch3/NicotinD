import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Lidarr, LidarrArtist } from '@nicotind/lidarr-client';
import { applySchema } from '../db.js';
import { getMbid } from './mbid-store.js';
import { makePluginArtistImageLookup } from './artist-image-plugin.js';
import type { PluginRegistry } from './plugins/registry.js';
import type { Plugin } from '@nicotind/core';

/**
 * The registry→chain bridge (issue #422): MBID-only resolution mirroring
 * `fetchAndStoreArtistInfo` (cache first, corroborated Lidarr fallback,
 * persisted), enablement re-checked per call.
 */

const artist = { id: 'a1', name: 'Aphex Twin' };

function registryWith(plugin: Plugin | null): PluginRegistry {
  return {
    getEnabledWithCapability: () => (plugin ? [plugin] : []),
  } as unknown as PluginRegistry;
}

function imagePlugin(fetch: (mbid: string) => Promise<string | null>): Plugin {
  return {
    manifest: { id: 'discogs' },
    artistImage: {
      fetchArtistImage: async ({ mbid }: { mbid: string }) => {
        const url = await fetch(mbid);
        return url ? { url, source: 'discogs', confidence: 0.95 } : null;
      },
    },
  } as unknown as Plugin;
}

function lidarrLookup(hits: Array<Partial<LidarrArtist>>): Lidarr {
  return { artist: { lookup: async () => hits as LidarrArtist[] } } as unknown as Lidarr;
}

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

describe('makePluginArtistImageLookup', () => {
  it('returns null when no artist-image-capable plugin is enabled', async () => {
    const lookup = makePluginArtistImageLookup({ db, lidarr: null, plugins: registryWith(null) });
    expect(await lookup(artist)).toBeNull();
  });

  it('resolves via a cached library_mbids row without touching Lidarr', async () => {
    db.run(
      `INSERT INTO library_mbids (scope, key, mbid, source, confidence, checked_at)
       VALUES ('artist', 'aphex twin', 'mbid-cached', 'lidarr', 0.8, 1)`,
    );
    const seen: string[] = [];
    const lookup = makePluginArtistImageLookup({
      db,
      lidarr: null, // would throw if the fallback ran — the cache must win
      plugins: registryWith(
        imagePlugin(async (mbid) => {
          seen.push(mbid);
          return 'https://img/d.jpg';
        }),
      ),
    });
    expect(await lookup(artist)).toBe('https://img/d.jpg');
    expect(seen).toEqual(['mbid-cached']);
  });

  it('is a confident miss (null, no name search) when no MBID can be resolved', async () => {
    let called = false;
    const lookup = makePluginArtistImageLookup({
      db,
      lidarr: null,
      plugins: registryWith(
        imagePlugin(async () => {
          called = true;
          return 'https://never.jpg';
        }),
      ),
    });
    expect(await lookup(artist)).toBeNull();
    expect(called).toBe(false);
  });

  it('falls back to a corroborated Lidarr lookup and persists the MBID', async () => {
    const lookup = makePluginArtistImageLookup({
      db,
      lidarr: lidarrLookup([{ artistName: 'Aphex Twin', foreignArtistId: 'mbid-lidarr' }]),
      plugins: registryWith(imagePlugin(async (mbid) => `https://img/${mbid}.jpg`)),
    });
    expect(await lookup(artist)).toBe('https://img/mbid-lidarr.jpg');
    // Persisted for the next caller (same discipline as fetchAndStoreArtistInfo).
    expect(getMbid(db, 'artist', 'aphex twin')?.mbid).toBe('mbid-lidarr');
  });

  it('yields null on a thrown source error (nothing tombstoned, retriable)', async () => {
    db.run(
      `INSERT INTO library_mbids (scope, key, mbid, source, confidence, checked_at)
       VALUES ('artist', 'aphex twin', 'mbid-x', 'lidarr', 0.8, 1)`,
    );
    const lookup = makePluginArtistImageLookup({
      db,
      lidarr: null,
      plugins: registryWith(
        imagePlugin(async () => {
          throw new Error('discogs 500');
        }),
      ),
    });
    expect(await lookup(artist)).toBeNull();
  });
});
