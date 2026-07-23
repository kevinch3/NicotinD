import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LidarrArtist } from '@nicotind/lidarr-client';
import { applySchema } from '../db.js';
import {
  indexLidarrArtists,
  resolveArtistImageUrl,
  type ArtistImageLidarr,
} from './artist-image.js';
import {
  buildArtistImageProviders,
  configuredArtistImageSources,
} from './artist-image-providers.js';

const poster = (url: string) => [{ coverType: 'poster', url }];

function lidarrMock(list: LidarrArtist[]): ArtistImageLidarr {
  return {
    artist: { list: async () => list, lookup: async () => [] },
  } as unknown as ArtistImageLidarr;
}

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

describe('configuredArtistImageSources', () => {
  const spotify = async () => null;

  it('lists both sources in priority order (lidarr before spotify)', () => {
    expect(
      configuredArtistImageSources({ lidarr: lidarrMock([]), spotifyLookup: spotify }),
    ).toEqual(['lidarr', 'spotify']);
  });

  it('lists only the configured source', () => {
    expect(configuredArtistImageSources({ lidarr: lidarrMock([]), spotifyLookup: null })).toEqual([
      'lidarr',
    ]);
    expect(configuredArtistImageSources({ lidarr: null, spotifyLookup: spotify })).toEqual([
      'spotify',
    ]);
  });

  it('is empty when nothing is configured (drives the task unavailable gate)', () => {
    expect(configuredArtistImageSources({ lidarr: null, spotifyLookup: null })).toEqual([]);
  });
});

describe('buildArtistImageProviders', () => {
  const artist = { id: 'a1', name: 'Radiohead' };

  it('builds the chain in priority order, skipping unconfigured sources', () => {
    expect(
      buildArtistImageProviders({
        db,
        lidarr: lidarrMock([]),
        index: indexLidarrArtists([]),
        spotifyLookup: async () => null,
      }).map((p) => p.source),
    ).toEqual(['lidarr', 'spotify']);

    expect(
      buildArtistImageProviders({
        db,
        lidarr: null,
        index: null,
        spotifyLookup: async () => null,
      }).map((p) => p.source),
    ).toEqual(['spotify']);

    expect(
      buildArtistImageProviders({ db, lidarr: null, index: null, spotifyLookup: null }),
    ).toEqual([]);
  });

  it('resolves the Lidarr poster first when both sources have an image', async () => {
    const lidarr = lidarrMock([
      { id: 7, artistName: 'Radiohead', images: poster('https://x/lidarr.jpg') } as LidarrArtist,
    ]);
    const providers = buildArtistImageProviders({
      db,
      lidarr,
      index: indexLidarrArtists(await lidarr.artist.list()),
      spotifyLookup: async () => 'https://x/spotify.jpg',
    });
    expect(await resolveArtistImageUrl(providers, artist)).toEqual({
      url: 'https://x/lidarr.jpg',
      source: 'lidarr',
    });
  });

  it('falls back to Spotify when Lidarr has no poster', async () => {
    const providers = buildArtistImageProviders({
      db,
      lidarr: lidarrMock([]),
      index: indexLidarrArtists([]),
      spotifyLookup: async () => 'https://x/spotify.jpg',
    });
    expect(await resolveArtistImageUrl(providers, artist)).toEqual({
      url: 'https://x/spotify.jpg',
      source: 'spotify',
    });
  });

  it('resolves via Spotify alone when Lidarr is unconfigured', async () => {
    const providers = buildArtistImageProviders({
      db,
      lidarr: null,
      index: null,
      spotifyLookup: async () => 'https://x/s.jpg',
    });
    expect(await resolveArtistImageUrl(providers, artist)).toEqual({
      url: 'https://x/s.jpg',
      source: 'spotify',
    });
  });

  it('returns null when the whole configured chain comes up empty', async () => {
    const providers = buildArtistImageProviders({
      db,
      lidarr: lidarrMock([]),
      index: indexLidarrArtists([]),
      spotifyLookup: async () => null,
    });
    expect(await resolveArtistImageUrl(providers, artist)).toBeNull();
  });

  it('honors the discography-link id inside the Lidarr provider (db coupling contained)', async () => {
    // The generic resolver never sees `db`; the Lidarr provider closes over it.
    db.run(
      'INSERT INTO artist_discography_links (artist_id, lidarr_id, mbid, checked_at) VALUES (?, ?, ?, 1)',
      ['a1', 7, 'mbid'],
    );
    const lidarr = lidarrMock([
      {
        id: 7,
        artistName: 'Stored Differently',
        images: poster('https://x/linked.jpg'),
      } as LidarrArtist,
    ]);
    const providers = buildArtistImageProviders({
      db,
      lidarr,
      index: indexLidarrArtists(await lidarr.artist.list()),
      spotifyLookup: null,
    });
    expect(await resolveArtistImageUrl(providers, { id: 'a1', name: 'Anything Else' })).toEqual({
      url: 'https://x/linked.jpg',
      source: 'lidarr',
    });
  });
});
