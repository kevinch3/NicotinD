import { createLogger, type ArchiveCandidate } from '@nicotind/core';

const log = createLogger('archive-search');

const ADVANCED_SEARCH = 'https://archive.org/advancedsearch.php';
const DEFAULT_ROWS = 20;

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

/**
 * Read-only metadata lane over archive.org's `advancedsearch.php`. Turns a free
 * text query (unified search) or an artist+album pair (hunt modal) into a list of
 * downloadable item candidates. It never downloads — the client hands a
 * candidate's `detailsUrl` to `/api/acquire`, which the `archive` plugin resolves.
 */
export class ArchiveSearchService {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  /** Free-text search (used by the main unified-search page). */
  async search(query: string, rows = DEFAULT_ROWS): Promise<ArchiveCandidate[]> {
    return this.query(query.trim(), rows);
  }

  /** Targeted artist + album search (used by the album-hunt modal). */
  async searchAlbum(
    artist: string,
    album: string,
    rows = DEFAULT_ROWS,
  ): Promise<ArchiveCandidate[]> {
    return this.query(`${artist} ${album}`.trim(), rows);
  }

  private async query(terms: string, rows: number): Promise<ArchiveCandidate[]> {
    if (!terms) return [];
    // Constrain to audio items; let archive.org's relevance ranking order them.
    const q = `(${terms}) AND mediatype:audio`;
    const params = new URLSearchParams({ q, rows: String(rows), page: '1', output: 'json' });
    for (const fl of ['identifier', 'title', 'creator', 'year']) params.append('fl[]', fl);
    const url = `${ADVANCED_SEARCH}?${params.toString()}`;

    let res: Response;
    try {
      res = await this.fetchFn(url);
    } catch (err) {
      log.warn({ err }, 'archive.org search request failed');
      return [];
    }
    if (!res.ok) {
      log.warn({ status: res.status }, 'archive.org search returned a non-OK status');
      return [];
    }
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
}
