import { describe, it, expect, mock } from 'bun:test';
import { NicotinDError } from '@nicotind/core';
import type { Lidarr, LidarrAlbum, LidarrArtist } from '@nicotind/lidarr-client';
import {
  CatalogService,
  filterAlbumsByRelevance,
  type CatalogAlbum,
} from './catalog-search.service';

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

  it('drops implausible placeholder release years (e.g. 0001)', async () => {
    const lidarr = {
      artist: { lookup: mock(async () => []) },
      album: {
        lookup: mock(async () => [
          makeAlbum({ id: 1, title: 'No Date', releaseDate: '0001-01-01' }),
        ]),
      },
    } as unknown as Lidarr;

    const result = await new CatalogService(lidarr).search('x');
    expect(result.albums[0]?.year).toBeUndefined();
  });

  it('scopes album cards to the matched artist, dropping unrelated title matches', async () => {
    const lidarr = {
      artist: {
        lookup: mock(async () => [makeArtist({ id: 1, artistName: 'Zara Larsson' })]),
      },
      album: {
        lookup: mock(async () => [
          makeAlbum({
            id: 1,
            title: 'Venus',
            artist: makeArtist({ id: 1, artistName: 'Zara Larsson' }),
          }),
          // A bootleg/mashup that merely mentions the artist in its title.
          makeAlbum({
            id: 2,
            title: 'Zara Larsson Megamix',
            artist: makeArtist({ id: 9, artistName: 'oneboredjeu' }),
          }),
        ]),
      },
    } as unknown as Lidarr;

    const result = await new CatalogService(lidarr).search('Zara Larsson');
    expect(result.albums.map((a) => a.title)).toEqual(['Venus']);
  });

  it('suppresses junk + flags discographyUnavailable when the named artist has no own albums', async () => {
    // Zara Larsson is matched as an artist, but album.lookup carries only
    // mashups/tributes by *other* artists — none of her real albums. §A6.
    const lidarr = {
      artist: {
        lookup: mock(async () => [makeArtist({ id: 1, artistName: 'Zara Larsson' })]),
      },
      album: {
        lookup: mock(async () => [
          makeAlbum({
            id: 2,
            title: 'Zara Larsson Megamix',
            artist: makeArtist({ id: 9, artistName: 'oneboredjeu' }),
          }),
          makeAlbum({
            id: 3,
            title: 'Zara Larsson discography',
            artist: makeArtist({ id: 8, artistName: 'Random Wikipedia Article' }),
          }),
        ]),
      },
    } as unknown as Lidarr;

    const result = await new CatalogService(lidarr).search('Zara Larsson');
    expect(result.albums).toEqual([]); // no junk cards
    expect(result.discographyUnavailable).toBe(true);
    expect(result.scopedArtist).toBe('Zara Larsson');
    expect(result.artists.map((a) => a.name)).toContain('Zara Larsson');
  });

  it('ranks own albums by type (Album > EP > Single) then newest first', async () => {
    const own = (id: number, title: string, albumType: string, releaseDate?: string) =>
      makeAlbum({
        id,
        title,
        albumType,
        releaseDate,
        artist: makeArtist({ id: 1, artistName: 'Zara Larsson' }),
      });
    const lidarr = {
      artist: { lookup: mock(async () => [makeArtist({ id: 1, artistName: 'Zara Larsson' })]) },
      album: {
        lookup: mock(async () => [
          own(1, 'A Single', 'Single', '2019-01-01'),
          own(2, 'Older Album', 'Album', '2017-01-01'),
          own(3, 'Newer Album', 'Album', '2021-01-01'),
          own(4, 'An EP', 'EP', '2020-01-01'),
        ]),
      },
    } as unknown as Lidarr;

    const result = await new CatalogService(lidarr).search('Zara Larsson');
    expect(result.albums.map((a) => a.title)).toEqual([
      'Newer Album',
      'Older Album',
      'An EP',
      'A Single',
    ]);
    expect(result.discographyUnavailable).toBeFalsy();
  });

  // Regression for the "almost every search dead-ends into the raw-fallback
  // banner" bug: reproduced live against prod Lidarr for "Deep Purple" and
  // "Cyndi Lauper", where album.lookup's free-text relevance ranking put 6-7
  // "Best of"/"Very Best Of" compilations ahead of the artist's real studio
  // albums — and Lidarr's own listByArtist discography carried *zero* of
  // those compilations, so resolving the top-ranked (and therefore most
  // likely clicked) card 404s almost every time. Fixture mirrors the real
  // Lidarr `album.lookup` ordering for "Deep Purple" (comps newest-first,
  // real albums oldest-last).
  it('demotes compilations behind the artist real releases, even when the comps are newer', async () => {
    const own = (
      id: number,
      title: string,
      releaseDate: string,
      secondaryTypes: string[] = [],
    ) =>
      makeAlbum({
        id,
        title,
        albumType: 'Album',
        releaseDate,
        secondaryTypes,
        artist: makeArtist({ id: 1, artistName: 'Deep Purple' }),
      });
    const lidarr = {
      artist: { lookup: mock(async () => [makeArtist({ id: 1, artistName: 'Deep Purple' })]) },
      album: {
        lookup: mock(async () => [
          own(1, 'Deep Purple Forever: The Very Best Of', '2005-01-01', ['Compilation']),
          own(2, 'The Best of Deep Purple', '2002-01-01', ['Compilation']),
          own(3, 'The Very Best of Deep Purple', '2000-01-01', ['Compilation']),
          own(4, 'Deepest Purple: The Very Best of Deep Purple', '1980-01-01', ['Compilation']),
          own(5, 'Deep Purple in Rock', '1970-01-01'),
          own(6, 'Deep Purple', '1969-01-01'),
          own(7, 'Shades of Deep Purple', '1968-01-01'),
        ]),
      },
    } as unknown as Lidarr;

    const result = await new CatalogService(lidarr).search('Deep Purple');
    expect(result.albums.map((a) => a.title)).toEqual([
      'Deep Purple in Rock',
      'Deep Purple',
      'Shades of Deep Purple',
      'Deep Purple Forever: The Very Best Of',
      'The Best of Deep Purple',
      'The Very Best of Deep Purple',
      'Deepest Purple: The Very Best of Deep Purple',
    ]);
  });

  it('keeps all albums when none belong to a matched artist (album-title search)', async () => {
    const lidarr = {
      artist: { lookup: mock(async () => []) },
      album: {
        lookup: mock(async () => [
          makeAlbum({
            id: 1,
            title: 'Discovery',
            artist: makeArtist({ id: 1, artistName: 'Daft Punk' }),
          }),
        ]),
      },
    } as unknown as Lidarr;

    const result = await new CatalogService(lidarr).search('Discovery');
    expect(result.albums).toHaveLength(1);
  });

  // Regression for the "La bifurcada" bug: a multi-word title search where the
  // rare second word makes Lidarr's fuzzy album.lookup collapse to the common
  // first token, flooding the grid with unrelated "La"/"Là" albums (the second
  // word looks stripped). None belong to a matched artist, so we hit the pure-
  // title fall-through — which must now drop the first-token junk.
  it('filters first-token fuzzy junk from a multi-word album-title search', async () => {
    const lidarr = {
      artist: {
        lookup: mock(async () => [makeArtist({ id: 1, artistName: 'La Oreja de Van Gogh' })]),
      },
      album: {
        lookup: mock(async () => [
          // The real match — its title contains both query tokens.
          makeAlbum({
            id: 1,
            title: 'La Bifurcada',
            artist: makeArtist({ id: 5, artistName: 'Bajofondo' }),
          }),
          // First-token junk Lidarr surfaces for the rare second word.
          makeAlbum({ id: 2, title: 'LA', artist: makeArtist({ id: 6, artistName: 'Teddy Thompson' }) }),
          makeAlbum({ id: 3, title: 'Là', artist: makeArtist({ id: 7, artistName: 'São Paris' }) }),
        ]),
      },
    } as unknown as Lidarr;

    const result = await new CatalogService(lidarr).search('La bifurcada');
    expect(result.albums.map((a) => a.title)).toEqual(['La Bifurcada']);
  });

  it('dedupes artist pills with the same normalized name', async () => {
    const lidarr = {
      artist: {
        lookup: mock(async () => [
          makeArtist({ id: 1, artistName: 'Zara' }),
          makeArtist({ id: 2, artistName: 'ZarA' }),
          makeArtist({ id: 3, artistName: 'Zara' }),
          makeArtist({ id: 4, artistName: 'Zara Larsson' }),
        ]),
      },
      album: { lookup: mock(async () => []) },
    } as unknown as Lidarr;

    const result = await new CatalogService(lidarr).search('zara');
    expect(result.artists.map((a) => a.name)).toEqual(['Zara', 'Zara Larsson']);
  });
});

describe('CatalogService.loadDiscography', () => {
  it('adds the artist if absent, then returns their listByArtist albums ranked', async () => {
    const add = mock(async (a: LidarrArtist) => ({ ...a, id: 7 }));
    const lidarr = {
      artist: {
        list: mock(async () => []),
        lookup: mock(async () => [
          makeArtist({ id: 0, foreignArtistId: 'zl-mbid', artistName: 'Zara Larsson' }),
        ]),
        getQualityProfiles: mock(async () => [{ id: 1, name: 'Any' }]),
        getMetadataProfiles: mock(async () => [{ id: 1, name: 'Std' }]),
        getRootFolders: mock(async () => [{ id: 1, path: '/music', freeSpace: 0 }]),
        add,
      },
      album: {
        listByArtist: mock(async () => [
          makeAlbum({ id: 1, title: 'So Good', albumType: 'Album', releaseDate: '2017-01-01' }),
          makeAlbum({ id: 2, title: 'A Single', albumType: 'Single', releaseDate: '2019-01-01' }),
          makeAlbum({ id: 3, title: 'Poster Girl', albumType: 'Album', releaseDate: '2021-01-01' }),
        ]),
      },
    } as unknown as Lidarr;

    const result = await new CatalogService(lidarr, '/music').loadDiscography(
      'zl-mbid',
      'Zara Larsson',
    );

    expect(add).toHaveBeenCalledTimes(1);
    // Albums first (newest), Single last; artistName backfilled from input.
    expect(result.albums.map((a) => a.title)).toEqual(['Poster Girl', 'So Good', 'A Single']);
    expect(result.albums.every((a) => a.artistName === 'Zara Larsson')).toBe(true);
    expect(result.scopedArtist).toBe('Zara Larsson');
  });

  it('reuses an already-added artist without re-adding', async () => {
    const add = mock(async () => makeArtist({ id: 99 }));
    const lidarr = {
      artist: { list: mock(async () => [makeArtist({ id: 5, foreignArtistId: 'zl-mbid' })]), add },
      album: {
        listByArtist: mock(async () => [makeAlbum({ id: 1, title: 'Venus', albumType: 'Album' })]),
      },
    } as unknown as Lidarr;

    const result = await new CatalogService(lidarr).loadDiscography('zl-mbid', 'Zara Larsson');
    expect(add).not.toHaveBeenCalled();
    expect(result.albums.map((a) => a.title)).toEqual(['Venus']);
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

  it('falls back to a normalized-title match when the foreignAlbumId is absent', async () => {
    // The artist's Lidarr discography carries the album under a *different*
    // release-group id (with a diacritic difference) than the search card's id.
    const lidarr = {
      artist: { list: mock(async () => [makeArtist({ id: 5, foreignArtistId: 'pf-mbid' })]) },
      album: {
        listByArtist: mock(async () => [
          makeAlbum({ id: 42, title: 'Ánimals', foreignAlbumId: 'rg-different' }),
        ]),
      },
    } as unknown as Lidarr;

    const result = await new CatalogService(lidarr).resolveAlbum(input);
    expect(result.lidarrAlbumId).toBe(42);
  });

  it('throws a 404 NicotinDError when no album matches by id or title', async () => {
    const lidarr = {
      artist: { list: mock(async () => [makeArtist({ id: 5, foreignArtistId: 'pf-mbid' })]) },
      album: {
        listByArtist: mock(async () => [
          makeAlbum({ id: 1, title: 'Other', foreignAlbumId: 'rg-other' }),
        ]),
      },
    } as unknown as Lidarr;

    const err = await new CatalogService(lidarr)
      .resolveAlbum(input)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NicotinDError);
    expect((err as NicotinDError).statusCode).toBe(404);
  });
});

describe('filterAlbumsByRelevance', () => {
  const album = (title: string, artistName = 'X'): CatalogAlbum => ({
    foreignAlbumId: `rg-${title}`,
    title,
    artistName,
    artistMbid: '',
    albumType: 'Album',
    secondaryTypes: [],
    trackCount: 0,
  });

  it('keeps only albums containing every query token', () => {
    const albums = [album('La Bifurcada'), album('LA'), album('Là')];
    expect(filterAlbumsByRelevance(albums, 'La bifurcada').map((a) => a.title)).toEqual([
      'La Bifurcada',
    ]);
  });

  it('matches accent-insensitively across title and artist', () => {
    const albums = [album('Ídolo', 'C. Tangana'), album('Random', 'Nobody')];
    expect(filterAlbumsByRelevance(albums, 'tangana idolo').map((a) => a.title)).toEqual(['Ídolo']);
  });

  it('returns everything for an empty/whitespace query', () => {
    const albums = [album('Anything'), album('Else')];
    expect(filterAlbumsByRelevance(albums, '   ')).toHaveLength(2);
  });
});
