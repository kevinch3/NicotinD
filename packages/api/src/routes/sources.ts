import { Hono } from 'hono';
import { createLogger } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import type { CandidateSearchAggregator } from '../services/candidate-search.js';

const log = createLogger('sources');

export interface SourcesRoutesOptions {
  aggregator: CandidateSearchAggregator;
}

/**
 * Source-agnostic acquisition search. `GET /api/sources/search?q=` fans the query
 * across every enabled metadata source (archive.org, Spotify, …) and returns one
 * blended, ranked `AcquisitionCandidate[]`. The web blends these with Soulseek's
 * live network results (kept on `/api/search` for real-time progress) into a
 * single results list. See docs/source-agnostic-acquisition.md.
 */
export function sourcesRoutes({ aggregator }: SourcesRoutesOptions) {
  const app = new Hono<AuthEnv>();

  app.get('/search', async (c) => {
    const q = c.req.query('q');
    if (!q) return c.json({ error: 'Query parameter "q" is required' }, 400);
    try {
      const candidates = await aggregator.search(q);
      return c.json({ candidates, sources: aggregator.enabledSourceIds() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ q, err: msg }, 'source search failed');
      // Per-source failures are already isolated in the aggregator; a throw here
      // is unexpected — degrade to an empty blend rather than 500 the search box.
      return c.json({ candidates: [], sources: aggregator.enabledSourceIds() });
    }
  });

  return app;
}
