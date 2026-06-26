import { describe, expect, it } from 'bun:test';
import {
  groupFoldersByAlbum,
  planTrackKeepers,
  type FolderEntry,
  type SourcedFile,
} from './repair-album-folders.js';

const f = (artist: string, album: string): FolderEntry => ({
  artist,
  album,
  dir: `${artist}/${album}`,
});

describe('groupFoldersByAlbum', () => {
  it('groups edition variants of one album together, keeps distinct albums apart', () => {
    const groups = groupFoldersByAlbum([
      f('Queen', 'Hot Space'),
      f('Queen', 'Hot Space (2011 Deluxe Remaster) 1'),
      f('Queen', 'Hot Space (Deluxe Remastered Version)'),
      f('Queen', 'Greatest Hits'),
      f('Queen', 'Greatest Hits II'),
    ]).map((g) => g.map((x) => x.album).sort());

    const hotSpace = groups.find((g) => g.some((n) => n.startsWith('Hot Space')));
    expect(hotSpace).toHaveLength(3);
    // Greatest Hits and Greatest Hits II are NOT merged.
    expect(groups.some((g) => g.length === 1 && g[0] === 'Greatest Hits')).toBe(true);
    expect(groups.some((g) => g.length === 1 && g[0] === 'Greatest Hits II')).toBe(true);
  });
});

describe('planTrackKeepers', () => {
  const file = (name: string, size = 1, dir = 'd'): SourcedFile => ({ name, size, dir });

  it('with a canonical tracklist: keeps one clean file per track + unmatched bonus, drops alt-mix versions', () => {
    const files = [
      file('01 - Song One.flac'),
      file('02 - Song Two.flac'),
      file('02 - Song Two (5.1 mix).flac'),
      file('02 - Song Two (New Mix).flac'),
      file('99 - Bonus Cut.flac'),
    ];
    const { keep, drop } = planTrackKeepers(files, ['Song One', 'Song Two']);
    // The clean per-track files survive; the unmatched "Bonus Cut" is NOT silently
    // deleted (it maps to no canonical track); only the (5.1 mix)/(New Mix)
    // versions of a matched track are dropped.
    expect(keep.map((k) => k.name).sort()).toEqual([
      '01 - Song One.flac',
      '02 - Song Two.flac',
      '99 - Bonus Cut.flac',
    ]);
    expect(drop.map((d) => d.name).sort()).toEqual([
      '02 - Song Two (5.1 mix).flac',
      '02 - Song Two (New Mix).flac',
    ]);
  });

  it('prefers FLAC/larger when several clean copies match a canonical track', () => {
    const files = [file('01 - Song One.mp3', 5), file('01 - Song One.flac', 2)];
    const { keep } = planTrackKeepers(files, ['Song One']);
    expect(keep.map((k) => k.name)).toEqual(['01 - Song One.flac']);
  });

  it('without a canonical list: collapses only true-duplicate copies, keeps distinct tracks', () => {
    const files = [
      file('02 - Song.mp3', 3),
      file('02 - Song (2).flac', 9),
      file('03 - Other (live).flac'),
    ];
    const { keep, drop } = planTrackKeepers(files);
    // FLAC copy kept over the mp3; the distinct "(live)" track survives.
    expect(keep.map((k) => k.name).sort()).toEqual([
      '02 - Song (2).flac',
      '03 - Other (live).flac',
    ]);
    expect(drop.map((d) => d.name)).toEqual(['02 - Song.mp3']);
  });

  it('--no-trim path (no canonical list) keeps distinct remixes/edits that trimming would drop', () => {
    // The exact files that the canonical-list path (first test) drops as alt mixes
    // must SURVIVE when no canonical list is passed — this is the `--no-trim`
    // guarantee that a bulk repair pass never loses non-canonical versions.
    const files = [
      file('02 - Song Two.flac'),
      file('02 - Song Two (5.1 mix).flac'),
      file('02 - Song Two (New Mix).flac'),
    ];
    const { keep, drop } = planTrackKeepers(files);
    expect(drop).toHaveLength(0);
    expect(keep.map((k) => k.name).sort()).toEqual([
      '02 - Song Two (5.1 mix).flac',
      '02 - Song Two (New Mix).flac',
      '02 - Song Two.flac',
    ]);
  });
});
