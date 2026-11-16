/**
 * Web search as extra evidence for a genre verdict (#1516 P5), against a
 * self-hosted SearXNG instance. Optional: with no `CURATOR_SEARCH_URL` the
 * runner never searches.
 *
 * Search is the scarce resource of a curation pass, so it is spent per album,
 * never per song, under a per-run budget, and every answer is cached in the
 * runner's state file. → docs/curator-runner.md "Web search"
 */
import type { Database } from 'bun:sqlite';

export interface SearchHit {
  title: string;
  snippet: string;
  url: string;
}

export interface WebSearch {
  /** The top hits for `query`. Throws on a failed request. */
  search(query: string): Promise<SearchHit[]>;
}

/** Hits kept per query: what one prompt can carry without drowning the tags. */
export const SEARCH_HITS = 5;
export const SEARCH_TIMEOUT_MS = 15_000;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** SearXNG's JSON API: `GET /search?q=…&format=json`. The instance must allow `json`. */
export function searxngSearch(baseUrl: string, fetchImpl: typeof fetch = fetch): WebSearch {
  const root = baseUrl.replace(/\/+$/, '');
  return {
    async search(query) {
      const res = await fetchImpl(`${root}/search?q=${encodeURIComponent(query)}&format=json`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`SearXNG answered HTTP ${res.status}`);
      const body = (await res.json()) as {
        results?: Array<{ title?: unknown; content?: unknown; url?: unknown }>;
      };
      return (body.results ?? [])
        .filter((r) => typeof r.title === 'string' && typeof r.url === 'string')
        .slice(0, SEARCH_HITS)
        .map((r) => ({
          title: clip(String(r.title).replace(/\s+/g, ' ').trim(), 160),
          snippet: clip(
            (typeof r.content === 'string' ? r.content : '').replace(/\s+/g, ' ').trim(),
            300,
          ),
          url: String(r.url),
        }));
    },
  };
}

export interface SearchUsage {
  /** Requests sent to the search instance this run. */
  made: number;
  /** Answers served from the cache. */
  cached: number;
  /** Requests that failed. */
  failed: number;
  /** Lookups refused because the budget was spent. */
  refused: number;
  budget: number;
}

/**
 * A search with a per-run budget and a cache. `lookup` returns null when there
 * is nothing to add: the budget is spent, or the request failed. A cached
 * answer, including an empty one, costs nothing.
 */
export class BudgetedSearch {
  readonly usage: SearchUsage;

  constructor(
    private readonly inner: WebSearch,
    private readonly db: Database,
    private readonly opts: { budget: number; cacheDays: number; now: () => number },
  ) {
    this.usage = { made: 0, cached: 0, failed: 0, refused: 0, budget: opts.budget };
    db.run(`CREATE TABLE IF NOT EXISTS searches (
      query TEXT PRIMARY KEY,
      hits  TEXT NOT NULL,
      at    INTEGER NOT NULL
    )`);
  }

  async lookup(query: string): Promise<SearchHit[] | null> {
    const key = query.trim().toLowerCase();
    const now = this.opts.now();
    const row = this.db
      .query<{ hits: string; at: number }, [string]>(
        'SELECT hits, at FROM searches WHERE query = ?',
      )
      .get(key);
    if (row && now - row.at < this.opts.cacheDays * 86_400_000) {
      this.usage.cached++;
      return JSON.parse(row.hits) as SearchHit[];
    }
    if (this.usage.made >= this.opts.budget) {
      this.usage.refused++;
      return null;
    }
    this.usage.made++;
    let hits: SearchHit[];
    try {
      hits = await this.inner.search(query);
    } catch {
      this.usage.failed++;
      return null;
    }
    this.db.run(
      `INSERT INTO searches (query, hits, at) VALUES (?, ?, ?)
       ON CONFLICT(query) DO UPDATE SET hits = excluded.hits, at = excluded.at`,
      [key, JSON.stringify(hits), now],
    );
    return hits;
  }
}

/**
 * The one query an album is worth, or null when a search would return noise.
 * A name alone is not searched: many artists share names, so the album title
 * has to be there to pin the artist down.
 */
export function searchQueryFor(cluster: { albumArtist: string; albumName: string }): string | null {
  const artist = cluster.albumArtist.trim();
  const album = cluster.albumName.trim();
  if (!artist || !album) return null;
  if (/^(various artists|unknown( artist)?|va)$/i.test(artist)) return null;
  return `"${artist}" "${album}" genre`;
}
