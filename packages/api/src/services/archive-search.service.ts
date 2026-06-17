import { createLogger, ServiceUnavailableError, type ArchiveCandidate } from '@nicotind/core';

const log = createLogger('archive-search');

const ADVANCED_SEARCH = 'https://archive.org/advancedsearch.php';
const DEFAULT_ROWS = 20;
// archive.org occasionally rate-limits or blips; one immediate retry recovers
// transient failures so a flaky response doesn't masquerade as "no results".
const MAX_RETRIES = 1;

// archive.org collections that are `mediatype:audio` but **not music** —
// audiobooks, spoken word, old-time radio, podcasts, sermons. A bare
// title/creator phrase match otherwise surfaces these (e.g. a LibriVox
// "Patchwork Girl of Oz" ranks for the query "Shaggy"), and downloading one
// ingests a multi-chapter audiobook as a bogus album. Excluding the collections
// keeps the lane musical. See docs/e2e-playground-findings-2026-06.md §B1.
const NON_MUSIC_COLLECTIONS = [
  'librivoxaudio',
  'audio_bookspoetry',
  'oldtimeradio',
  'radioprograms',
  'podcasts',
  'audio_religion',
  'audio_news',
];

interface ArchiveDoc {
  identifier: string;
  title?: string | string[];
  creator?: string | string[];
  year?: string | number;
}

interface AdvancedSearchResponse {
  response?: { docs?: ArchiveDoc[] };
}

const first = (v: string | string[] | undefined): string =>
  Array.isArray(v) ? (v[0] ?? '') : (v ?? '');

/** Quote a term as a Lucene phrase, escaping embedded quotes/backslashes. */
const phrase = (term: string): string => `"${term.replace(/[\\"]/g, '\\$&')}"`;

// Noise tokens stripped before deduping so format/quality/year variants of the
// same release collapse to one key.
const FORMAT_NOISE =
  /\b(flac|mp3|320|256|192|128|kbps|vbr|cbr|aac|ogg|opus|wav|m4a|24 ?bit|16 ?bit|hi ?res|lossless|remaster(ed)?|deluxe|edition)\b/g;

/**
 * Normalized dedupe key for an item: diacritic-folded, bracket/format/year noise
 * removed, reduced to a sorted set of tokens drawn from creator + title. This
 * collapses obvious variants of the same release — e.g.
 * `Porfiado · El Cuarteto De Nos` and `El Cuarteto de Nos - Porfiado (2012) [FLAC]`
 * both reduce to `cuarteto de el nos porfiado`. See findings §H4.
 */
export function archiveDedupeKey(c: { creator: string; title: string }): string {
  const raw = `${c.creator} ${c.title}`
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ') // drop bracketed tags
    .replace(/\b(19|20)\d{2}\b/g, ' ') // drop years
    .replace(FORMAT_NOISE, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return [...new Set(raw.split(' ').filter(Boolean))].sort().join(' ');
}

/**
 * Read-only metadata lane over archive.org's `advancedsearch.php`. Turns a free
 * text query (unified search) or an artist+album pair (hunt modal) into a list of
 * downloadable item candidates. It never downloads — the client hands a
 * candidate's `detailsUrl` to `/api/acquire`, which the `archive` plugin resolves.
 *
 * Queries are **field-targeted and phrase-quoted** (`title:`/`creator:`) rather
 * than a bare full-text match: an unscoped `(terms) AND mediatype:audio` matched
 * any audio item that merely *mentioned* the words (radio shows, mixtapes), which
 * buried real albums. See docs/e2e-playground-findings-2026-06.md §B.
 */
export class ArchiveSearchService {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  /** Free-text search (used by the main unified-search page). */
  async search(query: string, rows = DEFAULT_ROWS): Promise<ArchiveCandidate[]> {
    const terms = query.trim();
    if (!terms) return [];
    // Match the phrase against the music-relevant fields, not the full text.
    return this.run(`(title:(${phrase(terms)}) OR creator:(${phrase(terms)}))`, rows);
  }

  /** Targeted artist + album search (used by the album-hunt modal). */
  async searchAlbum(
    artist: string,
    album: string,
    rows = DEFAULT_ROWS,
  ): Promise<ArchiveCandidate[]> {
    const clauses: string[] = [];
    if (artist.trim()) clauses.push(`creator:(${phrase(artist.trim())})`);
    if (album.trim()) clauses.push(`title:(${phrase(album.trim())})`);
    if (clauses.length === 0) return [];
    return this.run(clauses.join(' AND '), rows);
  }

  private async run(expr: string, rows: number): Promise<ArchiveCandidate[]> {
    // Constrain to music: audio mediatype, minus the spoken-word/radio
    // collections that otherwise drown real albums (see NON_MUSIC_COLLECTIONS).
    const exclude = `-collection:(${NON_MUSIC_COLLECTIONS.join(' OR ')})`;
    const q = `${expr} AND mediatype:audio AND ${exclude}`;
    const params = new URLSearchParams({ q, rows: String(rows), page: '1', output: 'json' });
    for (const fl of ['identifier', 'title', 'creator', 'year']) params.append('fl[]', fl);
    // Rank by popularity so real, widely-downloaded music floats above obscure
    // mashups/uploads of unknown provenance.
    params.append('sort[]', 'downloads desc');
    const url = `${ADVANCED_SEARCH}?${params.toString()}`;

    const res = await this.fetchWithRetry(url);
    const body = (await res.json()) as AdvancedSearchResponse;
    const docs = body.response?.docs ?? [];
    const candidates = docs
      .filter((d) => d.identifier)
      .map((d) => ({
        identifier: d.identifier,
        title: first(d.title) || d.identifier,
        creator: first(d.creator),
        year: d.year != null ? String(d.year) : null,
        detailsUrl: `https://archive.org/details/${encodeURIComponent(d.identifier)}`,
      }));
    // Collapse format/quality/year variants of the same release. Results are
    // popularity-sorted, so keeping the first occurrence keeps the best copy.
    const seen = new Set<string>();
    return candidates.filter((c) => {
      const key = archiveDedupeKey(c);
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Fetch with one retry. Throws `ServiceUnavailableError` when archive.org is
   * unreachable or returns a non-OK status, so the caller can surface "archive.org
   * unavailable" instead of an empty result set (which means "no matches"). A
   * genuinely-empty `docs` array still resolves successfully.
   */
  private async fetchWithRetry(url: string): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await this.fetchFn(url);
        if (res.ok) return res;
        lastErr = new Error(`archive.org returned HTTP ${res.status}`);
      } catch (err) {
        lastErr = err;
      }
    }
    log.warn({ err: lastErr }, 'archive.org search request failed after retry');
    throw new ServiceUnavailableError('archive.org');
  }
}
