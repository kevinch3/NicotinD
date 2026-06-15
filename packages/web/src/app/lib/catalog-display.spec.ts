import { describe, it, expect } from 'vitest';
import { shouldOpenDirectSearch, discographyFallbackNote } from './catalog-display';
import type { CatalogSearchResult } from '../services/api.service';

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
