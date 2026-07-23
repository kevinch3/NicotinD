import { normalizeArtistForGrouping } from '../../album-grouping.js';

/**
 * Pure matching primitives for the Discogs source — no I/O, no clock, no state.
 * These are the "smart linking" seam: given what the host knows about a release
 * (artist + album, optionally MBIDs) and what Discogs returned, decide which
 * Discogs entity is really the same release, and reject look-alikes.
 *
 * Two resolution strategies, in the plugin's priority order:
 *  1. **MBID-first** — the trusted path. When the host carries an MBID, the
 *     enrichment layer resolves it to a Discogs URL via MusicBrainz's own
 *     `discogs` url-relation, and {@link parseDiscogsRef} extracts the Discogs
 *     id from that URL. No fuzzy matching, so no false pair.
 *  2. **Name search** — the fallback. A Discogs `/database/search` by artist +
 *     release title, then {@link selectBestRelease} picks the best hit *only*
 *     when both the artist AND the album title corroborate. Album-title
 *     corroboration is what rejects the "Emilia (Argentine) → Emilia (Swedish)"
 *     false match that same-name artists otherwise produce (#187).
 */

/** A resolved reference to a Discogs entity (what the client then fetches). */
export interface DiscogsRef {
  kind: 'release' | 'master' | 'artist';
  id: number;
}

/** One hit from Discogs `/database/search` (only the fields we score on). */
export interface DiscogsSearchHit {
  id: number;
  /** Discogs entity type: 'release' | 'master' | 'artist' | 'label' | … */
  type: string;
  /** Releases/masters come back as "Artist - Title". */
  title: string;
  year?: string;
  genre?: string[];
  style?: string[];
}

/** A fetched Discogs release/master (only the genre-bearing fields). */
export interface DiscogsGenreEntity {
  id?: number;
  genres?: string[];
  styles?: string[];
}

/** How well a search hit matched, and the ref it resolves to. */
export interface ReleaseMatch {
  ref: DiscogsRef;
  confidence: number;
}

/** Fold an artist name for comparison — accent-insensitive, keeps punctuation
 *  ("Miranda!" ≠ "Miranda"), matching the library's own grouping normaliser. */
export function foldArtist(s: string): string {
  return normalizeArtistForGrouping(s);
}

/** Fold a release title for comparison — accent-insensitive, punctuation-light
 *  (titles vary more freely in punctuation than artist names do). */
export function foldTitle(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse a Discogs entity URL into a {@link DiscogsRef}. This is the MBID-first
 * primitive: MusicBrainz's `discogs` url-relation points at a Discogs
 * release/master (e.g. `https://www.discogs.com/release/249504-…` or
 * `https://www.discogs.com/master/96559`), and this extracts the id + kind.
 * Both the human (`/release/`) and API (`/releases/`) URL shapes are accepted.
 * Returns null when the URL is not a recognisable Discogs entity URL.
 */
export function parseDiscogsRef(url: string): DiscogsRef | null {
  const m = url.match(/\/(releases?|masters?|artists?)\/(\d+)/i);
  if (!m) return null;
  const raw = m[1].toLowerCase();
  const kind: DiscogsRef['kind'] = raw.startsWith('release')
    ? 'release'
    : raw.startsWith('master')
      ? 'master'
      : 'artist';
  return { kind, id: Number(m[2]) };
}

/** Build the `/database/search` query params for a release name search. */
export function buildSearchParams(query: {
  artist: string;
  album: string;
}): Record<string, string> {
  return {
    artist: query.artist,
    release_title: query.album,
    type: 'release',
    per_page: '10',
  };
}

/** Split a Discogs "Artist - Title" hit title into its two folded halves. */
function splitHitTitle(title: string): { artist: string; album: string } {
  const idx = title.indexOf(' - ');
  if (idx === -1) return { artist: '', album: foldTitle(title) };
  return { artist: foldArtist(title.slice(0, idx)), album: foldTitle(title.slice(idx + 3)) };
}

/**
 * Score how well a search hit matches the query, in [0, 1]. Both halves must
 * corroborate: a hit that matches the artist but not the album title (the
 * same-name-different-release trap) scores low, not high. Exact folded equality
 * scores full; a containment match scores partial.
 */
export function scoreSearchHit(
  query: { artist: string; album: string },
  hit: DiscogsSearchHit,
): number {
  const wantArtist = foldArtist(query.artist);
  const wantAlbum = foldTitle(query.album);
  const got = splitHitTitle(hit.title);

  const artistScore =
    got.artist === wantArtist ? 1 : got.artist && wantArtist.includes(got.artist) ? 0.6 : 0;
  const albumScore =
    got.album === wantAlbum
      ? 1
      : wantAlbum && got.album && (got.album.includes(wantAlbum) || wantAlbum.includes(got.album))
        ? 0.6
        : 0;

  // Both halves are required — a zero on either collapses the whole score, which
  // is exactly the Swedish-Emilia rejection (right artist, wrong album → 0).
  if (artistScore === 0 || albumScore === 0) return 0;
  return 0.5 * artistScore + 0.5 * albumScore;
}

/**
 * Pick the best release/master hit at or above `minConfidence`, or null. Only
 * release-bearing hits are considered; `master` outranks `release` on an equal
 * score (a master groups editions, so its genres are the most representative).
 */
export function selectBestRelease(
  query: { artist: string; album: string },
  hits: readonly DiscogsSearchHit[],
  opts: { minConfidence?: number } = {},
): ReleaseMatch | null {
  const minConfidence = opts.minConfidence ?? 0.5;
  let best: ReleaseMatch | null = null;
  for (const hit of hits) {
    if (hit.type !== 'release' && hit.type !== 'master') continue;
    const confidence = scoreSearchHit(query, hit);
    if (confidence < minConfidence) continue;
    const ref: DiscogsRef = { kind: hit.type, id: hit.id };
    if (
      !best ||
      confidence > best.confidence ||
      (confidence === best.confidence && ref.kind === 'master' && best.ref.kind === 'release')
    ) {
      best = { ref, confidence };
    }
  }
  return best;
}

/** Extract + de-duplicate the genres and styles from a fetched release/master. */
export function mapReleaseGenres(entity: DiscogsGenreEntity): {
  genres: string[];
  styles: string[];
} {
  return {
    genres: dedupeTrim(entity.genres),
    styles: dedupeTrim(entity.styles),
  };
}

function dedupeTrim(values: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values ?? []) {
    const t = v.trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}
