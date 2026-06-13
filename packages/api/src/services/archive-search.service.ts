import { createLogger, ServiceUnavailableError, type ArchiveCandidate } from '@nicotind/core';

const log = createLogger('archive-search');

const ADVANCED_SEARCH = 'https://archive.org/advancedsearch.php';
const DEFAULT_ROWS = 20;
// archive.org occasionally rate-limits or blips; one immediate retry recovers
// transient failures so a flaky response doesn't masquerade as "no results".
const MAX_RETRIES = 1;

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
    const q = `${expr} AND mediatype:audio`;
    const params = new URLSearchParams({ q, rows: String(rows), page: '1', output: 'json' });
    for (const fl of ['identifier', 'title', 'creator', 'year']) params.append('fl[]', fl);
    const url = `${ADVANCED_SEARCH}?${params.toString()}`;

    const res = await this.fetchWithRetry(url);
    const body = (await res.json()) as AdvancedSearchResponse;
    const docs = body.response?.docs ?? [];
    return docs
      .filter((d) => d.identifier)
      .map((d) => ({
        identifier: d.identifier,
        title: first(d.title) || d.identifier,
        creator: first(d.creator),
        year: d.year != null ? String(d.year) : null,
        detailsUrl: `https://archive.org/details/${encodeURIComponent(d.identifier)}`,
      }));
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
