import { describe, it, expect } from 'vitest';
import {
  buildArtistAlbumTiles,
  partitionTiles,
  releaseYear,
  type AlbumTile,
} from './artist-album-tiles';
import type { Album, DiscographyAlbum } from '../services/api/api-types';

const local = (over: Partial<Album> & Pick<Album, 'id' | 'name'>): Album => ({
  artist: 'Pink Floyd',
  ...over,
});

const release = (
  over: Partial<DiscographyAlbum> & Pick<DiscographyAlbum, 'lidarrId' | 'title'>,
): DiscographyAlbum => ({
  foreignAlbumId: `mb-${over.lidarrId}`,
  albumType: 'Album',
  secondaryTypes: [],
  totalTracks: 10,
  localTrackCount: 0,
  status: 'missing',
  tracks: [],
  ...over,
});

const byTitle = (tiles: AlbumTile[]): Record<string, AlbumTile> =>
  Object.fromEntries(tiles.map((t) => [t.title, t]));

describe('buildArtistAlbumTiles', () => {
  it('renders a matched, complete release as one owned tile — not two', () => {
    const tiles = buildArtistAlbumTiles(
      [local({ id: 'a1', name: 'Meddle', year: 1971, coverArt: 'hash1' })],
      [
        release({
          lidarrId: 1,
          title: 'Meddle',
          status: 'present',
          localAlbumId: 'a1',
          localTrackCount: 6,
          totalTracks: 6,
          coverArtUrl: 'https://lidarr/meddle.jpg',
          releaseDate: '1971-10-30',
        }),
      ],
      { tab: 'albums' },
    );

    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toMatchObject({ title: 'Meddle', status: 'owned', localAlbumId: 'a1' });
    // The local cover wins — it is the art the user actually has on disk.
    expect(tiles[0].coverArt).toBe('hash1');
    // Nothing to do, so nothing to act on.
    expect(tiles[0].source).toBeUndefined();
  });

  it('marks a matched release with missing tracks partial, keeping it playable', () => {
    const entry = release({
      lidarrId: 2,
      title: 'A Saucerful of Secrets',
      status: 'partial',
      localAlbumId: 'a2',
      localTrackCount: 4,
      totalTracks: 7,
    });
    const tiles = buildArtistAlbumTiles(
      [local({ id: 'a2', name: 'A Saucerful of Secrets', year: 1968 })],
      [entry],
      { tab: 'albums' },
    );

    expect(tiles[0]).toMatchObject({
      status: 'partial',
      localAlbumId: 'a2',
      localTrackCount: 4,
      totalTracks: 7,
    });
    // A partial tile still navigates to the album — you own those four tracks.
    expect(tiles[0].source).toBe(entry);
  });

  it('keeps a local album the discography never mentions', () => {
    const tiles = buildArtistAlbumTiles(
      [local({ id: 'boot', name: 'Behind The Wall', year: 1979 })],
      [],
      { tab: 'albums' },
    );

    expect(tiles).toEqual([
      expect.objectContaining({ title: 'Behind The Wall', status: 'owned', localAlbumId: 'boot' }),
    ]);
  });

  it('renders an unowned release as a missing tile with its remote cover', () => {
    const tiles = buildArtistAlbumTiles(
      [],
      [
        release({
          lidarrId: 3,
          title: 'Atom Heart Mother',
          releaseDate: '1970-10-02',
          coverArtUrl: 'https://lidarr/ahm.jpg',
        }),
      ],
      { tab: 'albums' },
    );

    expect(tiles[0]).toMatchObject({
      title: 'Atom Heart Mother',
      status: 'missing',
      year: 1970,
      coverArtUrl: 'https://lidarr/ahm.jpg',
    });
    // Nothing local to open.
    expect(tiles[0].localAlbumId).toBeUndefined();
  });

  it('routes unowned EPs and singles to the singles tab, not the albums tab', () => {
    const discography = [
      release({ lidarrId: 4, title: 'An LP', albumType: 'Album' }),
      release({ lidarrId: 5, title: 'An EP', albumType: 'EP' }),
      release({ lidarrId: 6, title: 'A Single', albumType: 'Single' }),
    ];

    expect(buildArtistAlbumTiles([], discography, { tab: 'albums' }).map((t) => t.title)).toEqual([
      'An LP',
    ]);
    expect(
      buildArtistAlbumTiles([], discography, { tab: 'singles' })
        .map((t) => t.title)
        .sort(),
    ).toEqual(['A Single', 'An EP']);
  });

  it('leaves an owned tile in the tab its LOCAL row is in, whatever Lidarr calls it', () => {
    // Lidarr says EP; the library classified it an album. The library wins, so the
    // tile never disappears from the tab the user was looking at.
    const entry = release({
      lidarrId: 7,
      title: 'Ummagumma',
      albumType: 'EP',
      status: 'present',
      localAlbumId: 'a7',
    });
    const album = local({ id: 'a7', name: 'Ummagumma', year: 1969 });

    expect(buildArtistAlbumTiles([album], [entry], { tab: 'albums' })).toHaveLength(1);
    // ...and it is not ALSO drawn on the singles tab.
    expect(buildArtistAlbumTiles([], [entry], { tab: 'singles' })).toHaveLength(0);
  });

  it('orders newest first, undated last, with title breaking a tie', () => {
    const tiles = buildArtistAlbumTiles(
      [
        local({ id: 'x', name: 'Nineteen Seventy', year: 1970 }),
        local({ id: 'y', name: 'Undated' }),
        local({ id: 'z', name: 'Two Thousand', year: 2000 }),
        local({ id: 'w', name: 'Also Nineteen Seventy', year: 1970 }),
      ],
      [],
      { tab: 'albums' },
    );

    expect(tiles.map((t) => t.title)).toEqual([
      'Two Thousand',
      'Also Nineteen Seventy',
      'Nineteen Seventy',
      'Undated',
    ]);
  });

  it('collapses unowned live albums and compilations, but never owned ones', () => {
    const tiles = buildArtistAlbumTiles(
      [local({ id: 'own', name: 'Pulse', year: 1995 })],
      [
        release({ lidarrId: 8, title: 'Studio LP' }),
        release({ lidarrId: 9, title: 'A Live One', secondaryTypes: ['Live'] }),
        release({ lidarrId: 10, title: 'Greatest Hits', secondaryTypes: ['Compilation'] }),
        release({ lidarrId: 11, title: 'A Broadcast', albumType: 'Broadcast' }),
        // Owned, and live — stays visible because it is already in the library.
        release({
          lidarrId: 12,
          title: 'Pulse',
          secondaryTypes: ['Live'],
          status: 'present',
          localAlbumId: 'own',
        }),
      ],
      { tab: 'albums' },
    );

    const { primary, secondary } = partitionTiles(tiles);
    expect(primary.map((t) => t.title).sort()).toEqual(['Pulse', 'Studio LP']);
    expect(secondary.map((t) => t.title).sort()).toEqual([
      'A Broadcast',
      'A Live One',
      'Greatest Hits',
    ]);
  });

  it('shows an album twice when the SERVER match misses — the drift is visible, not hidden', () => {
    // `localAlbumId` is the server's `normalizeForGrouping` result. The web must not
    // add a second matcher to paper over a miss (#662/#706/#715 shipped as three
    // separate normalizer copies); the duplicate is today's behaviour made visible.
    const tiles = buildArtistAlbumTiles(
      [local({ id: 'a', name: 'The Wall [Remaster]', year: 1979 })],
      [release({ lidarrId: 13, title: 'The Wall', releaseDate: '1979-11-30' })],
      { tab: 'albums' },
    );

    expect(byTitle(tiles)['The Wall [Remaster]'].status).toBe('owned');
    expect(byTitle(tiles)['The Wall'].status).toBe('missing');
  });

  it('renders every local album when the discography failed to load', () => {
    // Lidarr unconfigured, artist unmatched, or the acquirer gate refused the
    // request — the grid must degrade to exactly what it showed before the merge.
    const albums = [
      local({ id: '1', name: 'One', year: 2001 }),
      local({ id: '2', name: 'Two', year: 2002 }),
    ];
    expect(buildArtistAlbumTiles(albums, [], { tab: 'albums' }).map((t) => t.title)).toEqual([
      'Two',
      'One',
    ]);
  });
});

describe('releaseYear', () => {
  it('reads the year off an ISO date and rejects Lidarr’s null date', () => {
    expect(releaseYear('1973-03-01')).toBe(1973);
    expect(releaseYear(undefined)).toBeNull();
    expect(releaseYear('0001-01-01')).toBe(1);
    expect(releaseYear('')).toBeNull();
  });
});
