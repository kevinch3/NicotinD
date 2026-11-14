import type { CatalogAlbum, CatalogArtist, CatalogSearchResult } from '../services/api/api-types';

/** Which kinds of work the Get page lists: `?scope=`. */
export type SearchScope = 'all' | 'albums' | 'tracks';

export const SEARCH_SCOPES: readonly SearchScope[] = ['all', 'albums', 'tracks'];

/** `?scope=` is free-form user input; anything unrecognised means all. */
export function parseScope(raw: string | null | undefined): SearchScope {
  return SEARCH_SCOPES.includes(raw as SearchScope) ? (raw as SearchScope) : 'all';
}

/** What the person most likely asked for, shown first as the Top result. */
export type SearchIntent<T> =
  | { kind: 'album'; album: CatalogAlbum }
  | { kind: 'artist'; artist: CatalogArtist }
  | { kind: 'track'; track: T }
  | null;

/** Lowercased, accent-free words, so "L'estasi dell'oro" and "lestasi delloro" meet. */
export function searchTokens(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * The one catalog album the query names: every query word is the album's or its
 * artist's, and every word of its title is in the query. A query that is only
 * the artist's name names no album, even one titled after the artist.
 */
function namedAlbum(query: string[], albums: readonly CatalogAlbum[]): CatalogAlbum | null {
  const asked = new Set(query);
  const hits = albums.filter((album) => {
    const title = searchTokens(album.title);
    const artist = new Set(searchTokens(album.artistName));
    if (title.length === 0 || query.every((w) => artist.has(w))) return false;
    const covered = new Set([...title, ...artist]);
    return query.every((w) => covered.has(w)) && title.every((w) => asked.has(w));
  });
  // Two editions with the same words are still one answer: the catalog's first.
  const titles = new Set(hits.map((a) => searchTokens(a.title).join(' ')));
  return titles.size === 1 ? hits[0]! : null;
}

/**
 * The Top result: the album the query names, else the artist when the query is
 * just the name the catalog scoped the search to, else the best track. Pure; the
 * page pins a track once shown so later peers never swap it.
 */
export function inferIntent<T>(
  query: string,
  catalog: CatalogSearchResult | null,
  bestTrack: T | null,
): SearchIntent<T> {
  const words = searchTokens(query);
  if (words.length === 0) return null;
  const album = catalog ? namedAlbum(words, catalog.albums) : null;
  if (album) return { kind: 'album', album };
  // The artist only when the query is just their name: extra words ask for a work.
  const scoped = catalog?.scopedArtist;
  if (scoped && words.every((w) => searchTokens(scoped).includes(w))) {
    const key = searchTokens(scoped).join(' ');
    const artist = catalog.artists.find((a) => searchTokens(a.name).join(' ') === key);
    if (artist) return { kind: 'artist', artist };
  }
  return bestTrack === null ? null : { kind: 'track', track: bestTrack };
}
