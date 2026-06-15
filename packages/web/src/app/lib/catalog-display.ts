import type { CatalogSearchResult } from '../services/api.service';

/**
 * The raw-network ("Advanced") lane should open when the guided path has no
 * actionable album cards — either no catalog hit at all, or an artist matched
 * but their discography wasn't available (§A6). Artist pills alone aren't
 * actionable (they just re-search), so they don't keep the lane closed.
 */
export function shouldOpenDirectSearch(catalog: CatalogSearchResult | null): boolean {
  return (catalog?.albums.length ?? 0) === 0;
}

/**
 * A short explanation shown when we confidently matched an artist but the
 * catalog carried none of their albums, so the UI dropped to the network lane.
 * Returns null when there's nothing to explain.
 */
export function discographyFallbackNote(catalog: CatalogSearchResult | null): string | null {
  if (catalog?.discographyUnavailable && catalog.scopedArtist) {
    return `We couldn't load ${catalog.scopedArtist}'s albums from the catalog — showing network results below.`;
  }
  return null;
}
