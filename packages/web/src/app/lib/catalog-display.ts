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
 * The reason the guided path fell back — structured so the template picks the
 * wording (and its i18n key) per kind, following the relative-time bucket/keys
 * split. `lookup-failed` wins: an outage must not read as "artist has no
 * albums" and push the user toward the Lidarr-mutating discography load (#665).
 */
export type DiscographyNote =
  { kind: 'no-albums'; artist: string } | { kind: 'lookup-failed'; artist: string | null };

export const DISCOGRAPHY_NOTE_KEYS: Record<DiscographyNote['kind'], string> = {
  'no-albums': 'acquire.discographyUnavailable',
  'lookup-failed': 'acquire.catalogLookupFailed',
};

export function discographyFallbackNote(
  catalog: CatalogSearchResult | null,
): DiscographyNote | null {
  if (catalog?.albumLookupFailed) {
    return { kind: 'lookup-failed', artist: catalog.scopedArtist ?? null };
  }
  if (catalog?.discographyUnavailable && catalog.scopedArtist) {
    return { kind: 'no-albums', artist: catalog.scopedArtist };
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
 *  empty list and both fallback flags clear (a successful load supersedes an
 *  earlier lookup failure). */
export function applyDiscography(
  catalog: CatalogSearchResult,
  loaded: CatalogSearchResult,
): CatalogSearchResult {
  return {
    ...catalog,
    albums: loaded.albums,
    discographyUnavailable: false,
    albumLookupFailed: false,
    scopedArtist: loaded.scopedArtist ?? catalog.scopedArtist,
  };
}
