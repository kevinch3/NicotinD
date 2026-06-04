import { describe, it, expect, mock } from 'bun:test';
import type { Lidarr, LidarrAlbum, LidarrArtist } from '@nicotind/lidarr-client';
import { CatalogService } from './catalog-search.service';

function makeArtist(over: Partial<LidarrArtist> & { id: number }): LidarrArtist {
  return {
    foreignArtistId: `mbid-${over.id}`,
    artistName: 'Artist',
    sortName: 'Artist',
    status: 'continuing',
    images: [],
    monitored: true,
    ...over,
  };
}

function makeAlbum(over: Partial<LidarrAlbum> & { id: number; title: string }): LidarrAlbum {
  return {
    foreignAlbumId: `rg-${over.id}`,
    albumType: 'Album',
    monitored: false,
    ...over,
  };
}

describe('CatalogService.search', () => {
  it('maps Lidarr artist + album lookups into catalog cards', async () => {
    const lidarr = {
      artist: {
        lookup: mock(async () => [
          makeArtist({
            id: 1,
            artistName: 'Pink Floyd',
            foreignArtistId: 'pf-mbid',
            images: [{ url: '/local.jpg', coverType: 'poster', remoteUrl: 'http://x/pf.jpg' }],
          }),
        ]),
      },
      album: {
        lookup: mock(async () => [
          makeAlbum({
            id: 10,
            title: 'The Dark Side of the Moon',
            foreignAlbumId: 'dsotm-rg',
            releaseDate: '1973-03-01',
            artist: makeArtist({ id: 1, artistName: 'Pink Floyd', foreignArtistId: 'pf-mbid' }),
            releases: [
              {
                id: 1,
                foreignReleaseId: 'r1',
                title: 't',
                status: 'official',
                duration: 0,
                trackCount: 9,
                media: [],
                country: [],
                label: [],
                disambiguation: '',
                format: 'CD',
                monitored: false,
              },
              {
                id: 2,
                foreignReleaseId: 'r2',
                title: 't',
                status: 'official',
                duration: 0,
                trackCount: 10,
                media: [],
                country: [],
                label: [],
                disambiguation: '',
                format: 'CD',
                monitored: false,
              },
            ],
            images: [{ url: '/c.jpg', coverType: 'cover', remoteUrl: 'http://x/c.jpg' }],
          }),
        ]),
      },
    } as unknown as Lidarr;

    const svc = new CatalogService(lidarr);
    const result = await svc.search('pink floyd');

    expect(result.artists[0]).toMatchObject({
      mbid: 'pf-mbid',
      name: 'Pink Floyd',
      imageUrl: 'http://x/pf.jpg',
    });
    expect(result.albums[0]).toMatchObject({
      foreignAlbumId: 'dsotm-rg',
      title: 'The Dark Side of the Moon',
      artistName: 'Pink Floyd',
      artistMbid: 'pf-mbid',
      year: '1973',
      trackCount: 10, // largest release wins
      coverUrl: 'http://x/c.jpg',
    });
  });

  it('returns partial results when one lookup fails', async () => {
    const lidarr = {
      artist: {
        lookup: mock(async () => {
          throw new Error('boom');
        }),
      },
      album: { lookup: mock(async () => [makeAlbum({ id: 1, title: 'X' })]) },
    } as unknown as Lidarr;

    const result = await new CatalogService(lidarr).search('x');
    expect(result.artists).toEqual([]);
    expect(result.albums).toHaveLength(1);
  });
});

describe('CatalogService.resolveAlbum', () => {
  const input = {
    foreignAlbumId: 'rg-10',
    artistMbid: 'pf-mbid',
    artistName: 'Pink Floyd',
    albumTitle: 'Animals',
  };

  it('resolves against an artist already in Lidarr (no add)', async () => {
    const add = mock(async () => makeArtist({ id: 99 }));
    const lidarr = {
      artist: { list: mock(async () => [makeArtist({ id: 5, foreignArtistId: 'pf-mbid' })]), add },
      album: {
        listByArtist: mock(async () => [
          makeAlbum({
            id: 10,
            title: 'Animals',
            foreignAlbumId: 'rg-10',
            statistics: { trackCount: 0, totalTrackCount: 5, sizeOnDisk: 0, percentOfTracks: 0 },
          }),
        ]),
      },
    } as unknown as Lidarr;

    const result = await new CatalogService(lidarr).resolveAlbum(input);

    expect(result).toMatchObject({ lidarrAlbumId: 10, totalTracks: 5, title: 'Animals' });
    expect(add).not.toHaveBeenCalled();
  });

  it('adds the artist on demand when absent, then resolves the album', async () => {
    const add = mock(async (a: LidarrArtist) => ({ ...a, id: 7 }));
    const lidarr = {
      artist: {
        list: mock(async () => []),
        lookup: mock(async () => [
          makeArtist({ id: 0, foreignArtistId: 'pf-mbid', artistName: 'Pink Floyd' }),
        ]),
        getQualityProfiles: mock(async () => [{ id: 1, name: 'Any' }]),
        getMetadataProfiles: mock(async () => [{ id: 1, name: 'Std' }]),
        getRootFolders: mock(async () => [{ id: 1, path: '/music', freeSpace: 0 }]),
        add,
      },
      album: {
        listByArtist: mock(async () => [
          makeAlbum({ id: 10, title: 'Animals', foreignAlbumId: 'rg-10' }),
        ]),
      },
    } as unknown as Lidarr;

    const result = await new CatalogService(lidarr, '/music').resolveAlbum(input);

    expect(add).toHaveBeenCalledTimes(1);
    expect(result.lidarrAlbumId).toBe(10);
  });

  it('throws when the resolved artist has no matching album', async () => {
    const lidarr = {
      artist: { list: mock(async () => [makeArtist({ id: 5, foreignArtistId: 'pf-mbid' })]) },
      album: {
        listByArtist: mock(async () => [
          makeAlbum({ id: 1, title: 'Other', foreignAlbumId: 'rg-other' }),
        ]),
      },
    } as unknown as Lidarr;

    await expect(new CatalogService(lidarr).resolveAlbum(input)).rejects.toThrow(
      /not yet available/i,
    );
  });
});
