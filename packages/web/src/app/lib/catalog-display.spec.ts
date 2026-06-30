import { describe, it, expect } from 'vitest';
import {
  shouldOpenDirectSearch,
  discographyFallbackNote,
  scopedArtistMbid,
  applyDiscography,
} from './catalog-display';
import type { CatalogSearchResult } from '../services/api/api-types';

const album = (title: string) => ({
  foreignAlbumId: title,
  title,
  artistName: 'Zara Larsson',
  artistMbid: 'm',
  albumType: 'Album',
  secondaryTypes: [],
  trackCount: 10,
});

const result = (over: Partial<CatalogSearchResult>): CatalogSearchResult => ({
  artists: [],
  albums: [],
  ...over,
});

describe('shouldOpenDirectSearch', () => {
  it('opens when there is no catalog at all', () => {
    expect(shouldOpenDirectSearch(null)).toBe(true);
  });

  it('opens when an artist matched but has no album cards (§A6)', () => {
    expect(
      shouldOpenDirectSearch(
        result({ artists: [{ mbid: 'm', name: 'Zara Larsson' }], albums: [], discographyUnavailable: true }),
      ),
    ).toBe(true);
  });

  it('stays closed when there are actionable album cards', () => {
    expect(
      shouldOpenDirectSearch(
        result({ albums: [{ foreignAlbumId: 'a', title: 'X', artistName: 'Y', artistMbid: 'm', albumType: 'Album', secondaryTypes: [], trackCount: 1 }] }),
      ),
    ).toBe(false);
  });
});

describe('discographyFallbackNote', () => {
  it('explains the network fallback when an artist matched with no albums', () => {
    expect(
      discographyFallbackNote(result({ scopedArtist: 'Zara Larsson', discographyUnavailable: true })),
    ).toBe("We couldn't load Zara Larsson's albums from the catalog — showing network results below.");
  });

  it('is null when albums are present or no artist was scoped', () => {
    expect(discographyFallbackNote(null)).toBeNull();
    expect(discographyFallbackNote(result({ scopedArtist: 'X' }))).toBeNull();
    expect(discographyFallbackNote(result({ discographyUnavailable: true }))).toBeNull();
  });
});

describe('scopedArtistMbid', () => {
  it('finds the scoped artist mbid from the pills (case-insensitive)', () => {
    expect(
      scopedArtistMbid(
        result({ scopedArtist: 'Zara Larsson', artists: [{ mbid: 'zl', name: 'zara larsson' }] }),
      ),
    ).toBe('zl');
  });

  it('is null without a scoped artist or matching pill', () => {
    expect(scopedArtistMbid(null)).toBeNull();
    expect(scopedArtistMbid(result({ scopedArtist: 'Zara Larsson', artists: [] }))).toBeNull();
  });
});

describe('applyDiscography', () => {
  it('replaces the empty album list with the loaded one and clears the flag', () => {
    const before = result({
      scopedArtist: 'Zara Larsson',
      discographyUnavailable: true,
      artists: [{ mbid: 'zl', name: 'Zara Larsson' }],
    });
    const loaded = result({ albums: [album('Poster Girl')], scopedArtist: 'Zara Larsson' });

    const after = applyDiscography(before, loaded);
    expect(after.albums.map((a) => a.title)).toEqual(['Poster Girl']);
    expect(after.discographyUnavailable).toBe(false);
    expect(after.artists).toEqual(before.artists); // pills preserved
  });
});
