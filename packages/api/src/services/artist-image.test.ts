import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LidarrArtist } from '@nicotind/lidarr-client';
import { applySchema } from '../db.js';
import {
  indexLidarrArtists,
  findLidarrArtist,
  resolveArtistImageUrl,
  type ArtistImageLidarr,
  type ArtistImageProvider,
} from './artist-image.js';

/** A stub provider that always returns `url` (or null) for its named source. */
function stubProvider(source: string, url: string | null): ArtistImageProvider {
  return { source, lookup: async () => url };
}

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
    const found = await findLidarrArtist(
      db,
      lidarr,
      indexLidarrArtists(await lidarr.artist.list()),
      {
        id: 'a1',
        name: 'Radiohead',
      },
    );
    expect(found?.id).toBe(7);
  });

  it('prefers the discography-link id over name', async () => {
    db.run(
      'INSERT INTO artist_discography_links (artist_id, lidarr_id, mbid, checked_at) VALUES (?, ?, ?, 1)',
      ['a1', 7, 'mbid'],
    );
    const lidarr = lidarrMock({
      list: [
        {
          id: 7,
          artistName: 'Stored Differently',
          images: poster('https://x/p.jpg'),
        } as LidarrArtist,
      ],
    });
    const found = await findLidarrArtist(
      db,
      lidarr,
      indexLidarrArtists(await lidarr.artist.list()),
      {
        id: 'a1',
        name: 'Anything Else',
      },
    );
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
    expect(
      await findLidarrArtist(db, lidarr, idx, { id: 'a1', name: 'Aphex Twin' }),
    ).toBeUndefined();
    expect(calls).toBe(0);
    const found = await findLidarrArtist(
      db,
      lidarr,
      idx,
      { id: 'a1', name: 'Aphex Twin' },
      {
        lookupMissing: true,
      },
    );
    expect(found?.artistName).toBe('Aphex Twin');
    expect(calls).toBe(1);
  });
});

describe('resolveArtistImageUrl (generic provider walk)', () => {
  const artist = { id: 'a1', name: 'Radiohead' };

  it('returns the first non-null provider hit, with its source', async () => {
    const r = await resolveArtistImageUrl(
      [
        stubProvider('lidarr', 'https://x/lidarr.jpg'),
        stubProvider('spotify', 'https://x/spotify.jpg'),
      ],
      artist,
    );
    expect(r).toEqual({ url: 'https://x/lidarr.jpg', source: 'lidarr' });
  });

  it('falls through a null provider to the next one', async () => {
    const r = await resolveArtistImageUrl(
      [stubProvider('lidarr', null), stubProvider('spotify', 'https://x/spotify.jpg')],
      artist,
    );
    expect(r).toEqual({ url: 'https://x/spotify.jpg', source: 'spotify' });
  });

  it('returns null when every provider comes up empty (no-match fallthrough)', async () => {
    const r = await resolveArtistImageUrl(
      [stubProvider('lidarr', null), stubProvider('spotify', null)],
      artist,
    );
    expect(r).toBeNull();
  });

  it('returns null for an empty chain', async () => {
    expect(await resolveArtistImageUrl([], artist)).toBeNull();
  });

  it('does not consult a later provider once an earlier one resolves', async () => {
    let spotifyCalls = 0;
    const spotify: ArtistImageProvider = {
      source: 'spotify',
      lookup: async () => {
        spotifyCalls += 1;
        return 'https://x/spotify.jpg';
      },
    };
    await resolveArtistImageUrl([stubProvider('lidarr', 'https://x/lidarr.jpg'), spotify], artist);
    expect(spotifyCalls).toBe(0);
  });
});
