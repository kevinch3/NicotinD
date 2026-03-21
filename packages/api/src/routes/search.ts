import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import type { ProviderRegistry } from '../services/provider-registry.js';

const emptyLocal = { artists: [] as unknown[], albums: [] as unknown[], songs: [] as unknown[] };

export function searchRoutes(registry: ProviderRegistry) {
  const app = new Hono<AuthEnv>();

  // Unified search: returns local results immediately + fires network search
  app.get('/', async (c) => {
    try {
      const query = c.req.query('q');
      if (!query) {
        return c.json({ error: 'Query parameter "q" is required' }, 400);
      }

      const errors: string[] = [];

      // 1. Query all local providers
      let local = emptyLocal;
      for (const provider of registry.getByType('local')) {
        try {
          const { results } = await provider.search(query);
          if (results) {
            local = {
              artists: results.artists,
              albums: results.albums,
              songs: results.songs,
            };
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('Unable to connect') || msg.includes('ConnectionRefused')) {
            errors.push(`${provider.name} is not reachable — local library unavailable`);
          } else {
            errors.push(`${provider.name} error: ${msg}`);
          }
        }
      }

      // 2. Fire all network providers
      let searchId: string = crypto.randomUUID();
      let networkAvailable = false;
      for (const provider of registry.getByType('network')) {
        try {
          const { searchId: providerSearchId } = await provider.search(query);
          if (providerSearchId) {
            searchId = providerSearchId;
            networkAvailable = true;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('Unable to connect') || msg.includes('ConnectionRefused')) {
            errors.push(`${provider.name} is not reachable — network unavailable`);
          } else {
            errors.push(`${provider.name} search failed: ${msg}`);
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({
        searchId: crypto.randomUUID(),
        local: emptyLocal,
        network: null,
        networkAvailable: false,
        errors: [`Search failed unexpectedly: ${msg}`],
      });
    }
  });

  // Poll network search results
  app.get('/:searchId/network', async (c) => {
    const searchId = c.req.param('searchId');

    for (const provider of registry.getByType('network')) {
      if (provider.pollResults) {
        try {
          return c.json(await provider.pollResults(searchId));
        } catch {
          return c.json({ state: 'complete', responseCount: 0, results: [] });
        }
      }
    }

    return c.json({ state: 'complete', responseCount: 0, results: [] });
  });

  // Cancel a search
  app.put('/:searchId/cancel', async (c) => {
    const searchId = c.req.param('searchId');

    for (const provider of registry.getByType('network')) {
      if (provider.cancelSearch) {
        await provider.cancelSearch(searchId);
      }
    }

    return c.json({ ok: true });
  });

  // Delete a search
  app.delete('/:searchId', async (c) => {
    const searchId = c.req.param('searchId');

    for (const provider of registry.getByType('network')) {
      if (provider.deleteSearch) {
        await provider.deleteSearch(searchId);
      }
    }

    return c.json({ ok: true });
  });

  return app;
}
