import { Hono } from 'hono';
import type { Navidrome } from '@nicotind/navidrome-client';
import type { AuthEnv } from '../middleware/auth.js';
import type { SlskdRef } from '../index.js';

// In-memory map of active network searches: searchId -> slskd search id
const activeSearches = new Map<string, string>();

const emptyLocal = { artists: [] as unknown[], albums: [] as unknown[], songs: [] as unknown[] };

export function searchRoutes(slskdRef: SlskdRef, navidrome: Navidrome) {
  const app = new Hono<AuthEnv>();

  // Unified search: returns local results immediately + fires network search
  app.get('/', async (c) => {
    const query = c.req.query('q');
    if (!query) {
      return c.json({ error: 'Query parameter "q" is required' }, 400);
    }

    const errors: string[] = [];

    // 1. Search local library via Navidrome (graceful if unavailable)
    let local = emptyLocal;
    try {
      const localResults = await navidrome.search.search3(query, {
        artistCount: 10,
        albumCount: 10,
        songCount: 20,
      });
      local = {
        artists: localResults.artist ?? [],
        albums: localResults.album ?? [],
        songs: localResults.song ?? [],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Unable to connect') || msg.includes('ConnectionRefused')) {
        errors.push('Navidrome is not reachable — local library unavailable');
      } else {
        errors.push(`Navidrome error: ${msg}`);
      }
    }

    // 2. Fire slskd search (non-blocking, graceful if unavailable)
    const searchId = crypto.randomUUID();
    let networkAvailable = false;
    const slskd = slskdRef.current;
    if (!slskd) {
      // Soulseek not configured — skip network search silently
    } else {
      try {
        const slskdSearch = await slskd.searches.create(query);
        activeSearches.set(searchId, slskdSearch.id);
        networkAvailable = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // 409 = duplicate search exists — clear old searches and retry
        if (msg.includes('409')) {
          try {
            const existing = await slskd.searches.list();
            for (const s of existing) {
              await slskd.searches.delete(s.id);
            }
            const retrySearch = await slskd.searches.create(query);
            activeSearches.set(searchId, retrySearch.id);
            networkAvailable = true;
          } catch (retryErr) {
            const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            errors.push(`Soulseek search failed: ${retryMsg}`);
          }
        } else if (msg.includes('Unable to connect') || msg.includes('ConnectionRefused')) {
          errors.push('slskd is not reachable — Soulseek network unavailable');
        } else {
          errors.push(`Soulseek search failed: ${msg}`);
        }
      }
    }

    return c.json({
      searchId,
      local,
      network: null,
      networkAvailable,
      errors: errors.length > 0 ? errors : undefined,
    });
  });

  // Poll network search results
  app.get('/:searchId/network', async (c) => {
    const searchId = c.req.param('searchId');
    const slskdSearchId = activeSearches.get(searchId);
    const slskd = slskdRef.current;

    if (!slskdSearchId || !slskd) {
      return c.json({ state: 'complete', responseCount: 0, results: [] });
    }

    try {
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
    } catch {
      return c.json({ state: 'complete', responseCount: 0, results: [] });
    }
  });

  // Cancel a search
  app.put('/:searchId/cancel', async (c) => {
    const searchId = c.req.param('searchId');
    const slskdSearchId = activeSearches.get(searchId);
    if (!slskdSearchId) {
      return c.json({ error: 'Search not found' }, 404);
    }

    if (slskdRef.current) await slskdRef.current.searches.cancel(slskdSearchId);
    return c.json({ ok: true });
  });

  // Delete a search
  app.delete('/:searchId', async (c) => {
    const searchId = c.req.param('searchId');
    const slskdSearchId = activeSearches.get(searchId);
    if (slskdSearchId && slskdRef.current) {
      await slskdRef.current.searches.delete(slskdSearchId);
      activeSearches.delete(searchId);
    }
    return c.json({ ok: true });
  });

  return app;
}
