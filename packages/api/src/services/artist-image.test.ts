import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LidarrArtist } from '@nicotind/lidarr-client';
import { applySchema } from '../db.js';
import {
  indexLidarrArtists,
  findLidarrArtist,
  resolveArtistImageUrl,
  type ArtistImageLidarr,
} from './artist-image.js';

const poster = (url: string) => [{ coverType: 'poster', url }];

function lidarrMock(data: { list?: LidarrArtist[]; lookup?: LidarrArtist[] }): ArtistImageLidarr {
  return {
    artist: {
      list: async () => data.list ?? [],
      lookup: async () => data.lookup ?? [],
    },
  } as unknown as ArtistImageLidarr;
}

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

describe('findLidarrArtist', () => {
  it('matches a monitored artist by name', async () => {
    const lidarr = lidarrMock({
      list: [{ id: 7, artistName: 'Radiohead', images: poster('https://x/p.jpg') } as LidarrArtist],
    });
    const found = await findLidarrArtist(db, lidarr, indexLidarrArtists(await lidarr.artist.list()), {
      id: 'a1',
      name: 'Radiohead',
    });
    expect(found?.id).toBe(7);
  });

  it('prefers the discography-link id over name', async () => {
    db.run(
      'INSERT INTO artist_discography_links (artist_id, lidarr_id, mbid, checked_at) VALUES (?, ?, ?, 1)',
      ['a1', 7, 'mbid'],
    );
    const lidarr = lidarrMock({
      list: [{ id: 7, artistName: 'Stored Differently', images: poster('https://x/p.jpg') } as LidarrArtist],
    });
    const found = await findLidarrArtist(db, lidarr, indexLidarrArtists(await lidarr.artist.list()), {
      id: 'a1',
      name: 'Anything Else',
    });
    expect(found?.id).toBe(7);
  });

  it('only falls back to lookup when lookupMissing is set', async () => {
    let calls = 0;
    const lidarr = {
      artist: {
        list: async () => [],
        lookup: async () => {
          calls += 1;
          return [{ id: 0, artistName: 'Aphex Twin', images: poster('https://x/a.jpg') }];
        },
      },
    } as unknown as ArtistImageLidarr;
    const idx = indexLidarrArtists([]);
    expect(await findLidarrArtist(db, lidarr, idx, { id: 'a1', name: 'Aphex Twin' })).toBeUndefined();
    expect(calls).toBe(0);
    const found = await findLidarrArtist(db, lidarr, idx, { id: 'a1', name: 'Aphex Twin' }, {
      lookupMissing: true,
    });
    expect(found?.artistName).toBe('Aphex Twin');
    expect(calls).toBe(1);
  });
});

describe('resolveArtistImageUrl', () => {
  const artist = { id: 'a1', name: 'Radiohead' };

  it('returns the Lidarr poster first', async () => {
    const lidarr = lidarrMock({
      list: [{ id: 7, artistName: 'Radiohead', images: poster('https://x/lidarr.jpg') } as LidarrArtist],
    });
    const spotify = async () => 'https://x/spotify.jpg';
    const r = await resolveArtistImageUrl(
      db,
      { lidarr, index: indexLidarrArtists(await lidarr.artist.list()), spotifyLookup: spotify },
      artist,
    );
    expect(r).toEqual({ url: 'https://x/lidarr.jpg', source: 'lidarr' });
  });

  it('falls back to Spotify when Lidarr has no image', async () => {
    const lidarr = lidarrMock({ list: [] });
    const r = await resolveArtistImageUrl(
      db,
      {
        lidarr,
        index: indexLidarrArtists([]),
        spotifyLookup: async () => 'https://x/spotify.jpg',
      },
      artist,
    );
    expect(r).toEqual({ url: 'https://x/spotify.jpg', source: 'spotify' });
  });

  it('returns null when neither source has an image', async () => {
    const r = await resolveArtistImageUrl(
      db,
      { lidarr: lidarrMock({ list: [] }), index: indexLidarrArtists([]), spotifyLookup: async () => null },
      artist,
    );
    expect(r).toBeNull();
  });

  it('works with only Spotify configured (no Lidarr)', async () => {
    const r = await resolveArtistImageUrl(
      db,
      { lidarr: null, index: null, spotifyLookup: async () => 'https://x/s.jpg' },
      artist,
    );
    expect(r).toEqual({ url: 'https://x/s.jpg', source: 'spotify' });
  });
});
