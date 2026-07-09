import { describe, it, expect } from 'vitest';
import { splitAlbumListType, parseMinTracks, activeExtraFilterCount } from './library-filters';

describe('splitAlbumListType (legacy type=starred mapping)', () => {
  it('round-trips a plain ordering', () => {
    expect(splitAlbumListType('recent')).toEqual({ sort: 'recent', starredOnly: false });
  });

  it('maps the legacy server starred type to the Starred filter (sort falls back)', () => {
    expect(splitAlbumListType('starred')).toEqual({ sort: 'newest', starredOnly: true });
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

describe('activeExtraFilterCount (page-specific extras; starred lives in LibraryFilter now)', () => {
  it('is zero with no extras', () => {
    expect(activeExtraFilterCount({ minTracks: null, showHidden: false })).toBe(0);
  });

  it('counts each active extra once', () => {
    expect(activeExtraFilterCount({ minTracks: 3, showHidden: true })).toBe(2);
    expect(activeExtraFilterCount({ minTracks: 5, showHidden: false })).toBe(1);
  });
});
