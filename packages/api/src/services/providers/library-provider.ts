import type { ISearchProvider, ProviderType, SearchProviderResult } from '@nicotind/core';
import type { Database } from 'bun:sqlite';
import { attachSongArtists, attachAlbumArtists } from '../artist-attach.js';

/**
 * Local search over the canonical library tables (library_artists/albums/songs)
 * — the native replacement for the Navidrome-backed local provider. Matches the
 * unified-search contract: returns results synchronously for the "local" lane.
 *
 * Matching is **tokenized + diacritic-insensitive** (see `matchesAllTokens`):
 * the query is folded (NFD → strip combining marks → lowercase) and split into
 * tokens, and every token must appear somewhere in a row's folded haystack
 * (title/name + artist). This fixes two gaps a single raw `LIKE '%query%'` had:
 *   1. **Multi-token queries.** "C. Tangana Ídolo" (artist + album typed
 *      together) never matched because artist and title live in different
 *      columns and no single column contains the whole string. Per-token AND
 *      matching over a combined haystack surfaces the album.
 *   2. **Accents.** SQLite's `COLLATE NOCASE` folds case but not diacritics, so
 *      "Idolo" (no accent) missed "Ídolo" (and worse, matched an unrelated
 *      "Idolo De Multitudes"). Folding both sides makes accent-optional queries
 *      resolve to the right release — important for an accent-heavy (Spanish)
 *      library.
 * Matching runs in JS over the visible rows (the library is small enough that
 * an unfiltered scan is a few ms); SQLite still does the cheap `hidden` /
 * `landed_at` gating so only real, in-library rows are considered.
 */
export class LibrarySearchProvider implements ISearchProvider {
  readonly name = 'library';
  readonly type: ProviderType = 'local';

  constructor(private db: Database) {}

  async search(query: string): Promise<{ results: SearchProviderResult | null }> {
    const q = query.trim();
    if (!q) return { results: { artists: [], albums: [], songs: [] } };
    const tokens = tokenize(q);
    if (tokens.length === 0) return { results: { artists: [], albums: [], songs: [] } };

    const artists = this.db
      .query<{ id: string; name: string; album_count: number }, []>(
        // Only surface artists with at least one landed (non-quarantined) song —
        // an artist whose tracks are all still processing isn't in the library yet.
        `SELECT id, name, album_count FROM library_artists
         WHERE hidden = 0
           AND EXISTS (SELECT 1 FROM library_songs s
             WHERE (s.artist_id = library_artists.id
               OR s.id IN (SELECT song_id FROM library_song_artists WHERE artist_id = library_artists.id))
             AND s.landed_at IS NOT NULL)`,
      )
      .all()
      .filter((r) => matchesAllTokens(r.name, tokens))
      .sort(rankBy(tokens, (r) => r.name))
      .slice(0, 10)
      .map((r) => ({ id: r.id, name: r.name, albumCount: r.album_count }));

    const albums = this.db
      .query<
        {
          id: string;
          name: string;
          artist: string;
          year: number | null;
          cover_art: string | null;
          song_count: number;
          classification: string;
        },
        []
      >(
        // Every visible, non-quarantined album — including the EPs/singles/
        // compilations the default Albums grid omits (the search page has its
        // own section rendering, so classification != 'album' is fine).
        // Quarantined albums (any un-landed track) are excluded — not "in your
        // library" yet. Token matching runs over "name + artist" in JS below.
        `SELECT id, name, artist, year, cover_art, song_count, classification
         FROM library_albums
         WHERE hidden = 0
           AND id NOT IN (SELECT DISTINCT album_id FROM library_songs WHERE landed_at IS NULL)`,
      )
      .all()
      .filter((r) => matchesAllTokens(`${r.name} ${r.artist}`, tokens))
      .sort(rankBy(tokens, (r) => r.name))
      .slice(0, 20)
      .map((r) => ({
        id: r.id,
        name: r.name,
        artist: r.artist,
        year: r.year ?? undefined,
        coverArt: r.cover_art ?? undefined,
        songCount: r.song_count,
        classification: r.classification as 'album' | 'ep' | 'single' | 'compilation' | 'unknown',
      }));

    const songs = this.db
      .query<
        {
          id: string;
          title: string;
          artist: string;
          artist_id: string;
          album: string | null;
          duration: number;
          bit_rate: number | null;
          cover_art: string | null;
        },
        []
      >(
        `SELECT s.id, s.title, s.artist, s.artist_id, a.name AS album, s.duration, s.bit_rate, s.cover_art
         FROM library_songs s
         LEFT JOIN library_albums a ON a.id = s.album_id
         WHERE s.hidden = 0 AND s.landed_at IS NOT NULL`,
      )
      .all()
      // Match over title + artist + album so a search for an album title also
      // surfaces its tracks (and an "artist track" query resolves).
      .filter((r) => matchesAllTokens(`${r.title} ${r.artist} ${r.album ?? ''}`, tokens))
      .sort(rankBy(tokens, (r) => r.title))
      .slice(0, 40)
      .map((r) => ({
        id: r.id,
        title: r.title,
        artist: r.artist,
        artistId: r.artist_id,
        album: r.album ?? '',
        duration: r.duration,
        bitRate: r.bit_rate ?? undefined,
        coverArt: r.cover_art ?? undefined,
      }));

    // Surface multi-artist credits so search rows render linked artists (same as
    // library/album/artist pages) instead of a plain string.
    attachAlbumArtists(this.db, albums);
    attachSongArtists(this.db, songs);

    return { results: { artists, albums, songs } };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

/**
 * Fold text for accent-insensitive matching: NFD-decompose, drop combining
 * marks (diacritics — "Ídolo" → "idolo", "niño" → "nino"), lowercase. Base
 * letters (incl. non-Latin scripts) are preserved so Cyrillic/etc. queries
 * still match.
 */
function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Split a query into folded tokens on any non-alphanumeric boundary (Unicode
 * aware, so "C. Tangana Ídolo" → ["c", "tangana", "idolo"]). Every token must
 * match for a row to qualify (AND semantics).
 */
export function tokenize(q: string): string[] {
  return fold(q)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** True when every query token is a substring of the folded haystack. */
export function matchesAllTokens(haystack: string, tokens: string[]): boolean {
  const h = fold(haystack);
  return tokens.every((t) => h.includes(t));
}

/**
 * Comparator that ranks matched rows: an exact folded-name match first, then a
 * name that starts with the whole folded query, then a name starting with the
 * first token, then alphabetical. Keeps the most-relevant hit at the top of
 * each capped section without a heavy scorer.
 */
function rankBy<T>(tokens: string[], nameOf: (row: T) => string): (a: T, b: T) => number {
  const joined = tokens.join(' ');
  const score = (row: T): number => {
    const n = fold(nameOf(row));
    if (n === joined) return 0;
    if (n.startsWith(joined)) return 1;
    if (n.startsWith(tokens[0]!)) return 2;
    return 3;
  };
  return (a, b) => score(a) - score(b) || nameOf(a).localeCompare(nameOf(b));
}
