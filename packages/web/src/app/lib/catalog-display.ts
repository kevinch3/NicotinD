import type { CatalogSearchResult } from '../services/api/api-types';

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

/**
 * The MusicBrainz id of the scoped artist (so we can load their discography on
 * demand). Returns null when there's no scoped artist or it isn't in the pills.
 */
export function scopedArtistMbid(catalog: CatalogSearchResult | null): string | null {
  if (!catalog?.scopedArtist) return null;
  const norm = (s: string) => s.trim().toLowerCase();
  const hit = catalog.artists.find((a) => norm(a.name) === norm(catalog.scopedArtist!));
  return hit?.mbid ?? null;
}

/** Merge a loaded discography into the catalog: real album cards replace the
 *  empty list and the "unavailable" flag clears. */
export function applyDiscography(
  catalog: CatalogSearchResult,
  loaded: CatalogSearchResult,
): CatalogSearchResult {
  return {
    ...catalog,
    albums: loaded.albums,
    discographyUnavailable: false,
    scopedArtist: loaded.scopedArtist ?? catalog.scopedArtist,
  };
}
