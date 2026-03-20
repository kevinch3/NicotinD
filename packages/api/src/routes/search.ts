import { Hono } from 'hono';
import type { Slskd } from '@nicotind/slskd-client';
import type { Navidrome } from '@nicotind/navidrome-client';
import type { AuthEnv } from '../middleware/auth.js';

// In-memory map of active network searches: searchId -> slskd search id
const activeSearches = new Map<string, string>();

export function searchRoutes(slskd: Slskd, navidrome: Navidrome) {
  const app = new Hono<AuthEnv>();

  // Unified search: returns local results immediately + fires network search
  app.get('/', async (c) => {
    const query = c.req.query('q');
    if (!query) {
      return c.json({ error: 'Query parameter "q" is required' }, 400);
    }

    // 1. Search local library via Navidrome
    const localResults = await navidrome.search.search3(query, {
      artistCount: 10,
      albumCount: 10,
      songCount: 20,
    });

    // 2. Fire slskd search (non-blocking)
    const slskdSearch = await slskd.searches.create(query);
    const searchId = crypto.randomUUID();
    activeSearches.set(searchId, slskdSearch.id);

    return c.json({
      searchId,
      local: {
        artists: localResults.artist,
        albums: localResults.album,
        songs: localResults.song,
      },
      network: null, // Client polls /search/:searchId/network
    });
  });

  // Poll network search results
  app.get('/:searchId/network', async (c) => {
    const searchId = c.req.param('searchId');
    const slskdSearchId = activeSearches.get(searchId);

    if (!slskdSearchId) {
      return c.json({ error: 'Search not found' }, 404);
    }

    const search = await slskd.searches.get(slskdSearchId);
    const responses = await slskd.searches.getResponses(slskdSearchId);

    return c.json({
      state: search.state === 'InProgress' ? 'searching' : 'complete',
      responseCount: search.responseCount,
      results: responses.map((r) => ({
        username: r.username,
        freeUploadSlots: r.freeUploadSlots,
        uploadSpeed: r.uploadSpeed,
        files: r.files.map((f) => ({
          filename: f.filename,
          size: f.size,
          bitRate: f.bitRate,
          length: f.length,
        })),
      })),
    });
  });

  // Cancel a search
  app.put('/:searchId/cancel', async (c) => {
    const searchId = c.req.param('searchId');
    const slskdSearchId = activeSearches.get(searchId);
    if (!slskdSearchId) {
      return c.json({ error: 'Search not found' }, 404);
    }

    await slskd.searches.cancel(slskdSearchId);
    return c.json({ ok: true });
  });

  // Delete a search
  app.delete('/:searchId', async (c) => {
    const searchId = c.req.param('searchId');
    const slskdSearchId = activeSearches.get(searchId);
    if (slskdSearchId) {
      await slskd.searches.delete(slskdSearchId);
      activeSearches.delete(searchId);
    }
    return c.json({ ok: true });
  });

  return app;
}
