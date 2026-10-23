import { describe, expect, it } from 'vitest';
import type { FolderGroup } from './folder-utils';
import { availabilityFor, folderIsAlbum, providerOnlyAlbums } from './provider-albums';

/** A peer folder with `n` tracks — directories are the shapes seen on prod (2026-10-23). */
function folder(username: string, directory: string, n: number, ext = 'flac'): FolderGroup {
  return {
    username,
    uploadSpeed: 1,
    directory,
    files: Array.from({ length: n }, (_, i) => ({
      filename: `${directory}\\${String(i + 1).padStart(2, '0')} Track.${ext}`,
      size: 10,
    })),
  };
}

const LAZARUS = [
  folder('dotproduct', 'music\\Damian Lazarus\\Smoke The Monster Out [2009]', 13),
  folder('peerB', '@@x\\Electronic\\Damian Lazarus - Smoke the Monster Out (2009)', 13, 'mp3'),
  folder(
    'Johnyboy123',
    '@@nncnz\\Flac albumi\\Elektronika\\Damian Lazarus & The Ancient Moons - Message From The Other Side [2015]',
    14,
  ),
  folder(
    'bunraku',
    'Music\\MP3\\Damian Lazarus & The Ancient Moons\\Message From the Other Side',
    14,
    'mp3',
  ),
  folder('mixer', 'mixes\\fabric 54 - Damian Lazarus', 21),
  folder('soiliclese', 'Trip-Hop', 50, 'mp3'),
  folder('single', 'Damian Lazarus\\Neverending', 2),
];

describe('folderIsAlbum', () => {
  it('matches a copy by any path segment, through "Artist - " and year noise', () => {
    const album = { artistName: 'Damian Lazarus', title: 'Smoke the Monster Out' };
    expect(folderIsAlbum(LAZARUS[0]!, album)).toBe(true);
    expect(folderIsAlbum(LAZARUS[1]!, album)).toBe(true);
  });

  it('counts a collaboration credit and a compilation named after the artist', () => {
    expect(
      folderIsAlbum(LAZARUS[2]!, {
        artistName: 'Damian Lazarus',
        title: 'Message From the Other Side',
      }),
    ).toBe(true);
    expect(
      folderIsAlbum(LAZARUS[4]!, {
        artistName: 'Damian Lazarus',
        title: 'Fabric 54: Damian Lazarus',
      }),
    ).toBe(true);
  });

  it('never matches a longer title or another artist', () => {
    const mare = folder('p', 'Music\\Christian Löffler\\2017 - Mare Reworks', 13);
    expect(folderIsAlbum(mare, { artistName: 'Christian Löffler', title: 'Mare' })).toBe(false);
    expect(
      folderIsAlbum(LAZARUS[0]!, { artistName: 'Kassem Mosse', title: 'Smoke the Monster Out' }),
    ).toBe(false);
  });
});

describe('availabilityFor', () => {
  it('counts peers, the best copy and whether one is lossless and complete', () => {
    const a = availabilityFor(
      { artistName: 'Damian Lazarus', title: 'Smoke the Monster Out', trackCount: 13 },
      LAZARUS,
    );
    expect(a).toMatchObject({ peers: 2, bestTracks: 13, lossless: true, complete: true });
  });

  // Prod: "Neverending" had no peer — its card must say so instead of looking like the rest.
  it('is null when no peer holds an album-shaped copy', () => {
    expect(
      availabilityFor(
        { artistName: 'Damian Lazarus', title: 'Neverending', trackCount: 4 },
        LAZARUS,
      ),
    ).toBeNull();
  });
});

describe('providerOnlyAlbums', () => {
  it('surfaces what the network holds that the catalog does not, most peers first', () => {
    const catalog = [{ artistName: 'Damian Lazarus', title: 'Smoke the Monster Out' }];
    const albums = providerOnlyAlbums(LAZARUS, catalog, 'Damian Lazarus');
    // "Fabric 54 - Damian Lazarus" names the artist as its *title*: a container
    // shape, so it is not offered as an album of its own.
    expect(albums.map((a) => [a.title.toLowerCase(), a.availability.peers])).toEqual([
      ['message from the other side', 2],
    ]);
  });

  it("finds Löffler's albums the catalog grid missed", () => {
    const folders = [
      folder('a', 'Music\\Christian Löffler\\2016 - Mare', 17),
      folder('b', 'music\\Christian Loffler\\Mare [FLAC]', 17),
      folder('c', 'Christian Löffler - A Life (2024)', 11),
      folder('d', 'Music\\Christian Löffler\\2014.04.17 - Young Alaska [FLAC]', 8),
    ];
    const catalog = [{ artistName: 'Christian Löffler', title: 'Young Alaska' }];
    expect(providerOnlyAlbums(folders, catalog, 'Christian Löffler').map((a) => a.title)).toEqual([
      'Mare',
      'A Life',
    ]);
  });

  it('skips a folder named only after the artist, and folders of other acts', () => {
    const folders = [
      folder('a', 'Music\\Damian Lazarus', 12),
      folder('b', 'Music\\Kassem Mosse\\Workshop 19', 9),
    ];
    expect(providerOnlyAlbums(folders, [], 'Damian Lazarus')).toEqual([]);
  });
});
