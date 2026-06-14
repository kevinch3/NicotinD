import { describe, it, expect } from 'vitest';
import {
  effectiveAlbumListType,
  splitAlbumListType,
  parseMinTracks,
  activeFilterCount,
} from './library-filters';

describe('effectiveAlbumListType', () => {
  it('uses the chosen ordering when Starred is off', () => {
    expect(effectiveAlbumListType('frequent', false)).toBe('frequent');
    expect(effectiveAlbumListType('alphabeticalByName', false)).toBe('alphabeticalByName');
  });

  it('forces the server "starred" type when Starred is on, regardless of sort', () => {
    expect(effectiveAlbumListType('frequent', true)).toBe('starred');
    expect(effectiveAlbumListType('random', true)).toBe('starred');
  });
});

describe('splitAlbumListType (inverse)', () => {
  it('round-trips a plain ordering', () => {
    expect(splitAlbumListType('recent')).toEqual({ sort: 'recent', starredOnly: false });
  });

  it('maps the server starred type to the Starred filter (sort falls back)', () => {
    expect(splitAlbumListType('starred')).toEqual({ sort: 'newest', starredOnly: true });
  });

  it('is the inverse of effectiveAlbumListType for non-starred sorts', () => {
    for (const sort of ['newest', 'frequent', 'recent', 'alphabeticalByName', 'random'] as const) {
      const { sort: back } = splitAlbumListType(effectiveAlbumListType(sort, false));
      expect(back).toBe(sort);
    }
  });
});

describe('parseMinTracks', () => {
  it('treats "" as no minimum', () => {
    expect(parseMinTracks('')).toBeNull();
  });

  it('parses numeric strings', () => {
    expect(parseMinTracks('1')).toBe(1);
    expect(parseMinTracks('10')).toBe(10);
  });
});

describe('activeFilterCount', () => {
  it('is zero with no filters', () => {
    expect(activeFilterCount({ starredOnly: false, minTracks: null, showHidden: false })).toBe(0);
  });

  it('counts each active filter once', () => {
    expect(activeFilterCount({ starredOnly: true, minTracks: 3, showHidden: true })).toBe(3);
    expect(activeFilterCount({ starredOnly: false, minTracks: 5, showHidden: false })).toBe(1);
  });
});
