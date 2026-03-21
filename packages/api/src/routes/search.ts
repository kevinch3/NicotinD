import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { AuthEnv } from '../middleware/auth.js';
import type { ProviderRegistry } from '../services/provider-registry.js';

const UnifiedSearchResponseSchema = z.object({
  searchId: z.string().uuid(),
  local: z.any(),
  network: z.any().nullable(),
  networkAvailable: z.boolean(),
  errors: z.array(z.string()).optional(),
}).openapi('UnifiedSearchResponse');

const NetworkSearchResponseSchema = z.object({
  state: z.string(),
  responseCount: z.number(),
  results: z.array(z.any()),
  canBrowse: z.boolean(),
  errors: z.array(z.string()).optional(),
}).openapi('NetworkSearchResponse');

const emptyLocal = { artists: [] as unknown[], albums: [] as unknown[], songs: [] as unknown[] };

export function searchRoutes(registry: ProviderRegistry) {
  const app = new OpenAPIHono<AuthEnv>();

  // Unified search: returns local results immediately + fires network search
  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      request: {
        query: z.object({
          q: z.string().openapi({ example: 'pink floyd' }),
        }),
      },
      responses: {
        200: {
          content: {
            'application/json': {
              schema: UnifiedSearchResponseSchema,
            },
          },
          description: 'Unified search result with local results and network search ID',
        },
        400: {
          content: {
            'application/json': {
              schema: z.object({ error: z.string() }),
            },
          },
          description: 'Error response',
        },
        500: {
          content: {
            'application/json': {
              schema: UnifiedSearchResponseSchema,
            },
          },
          description: 'Unexpected error',
        },
      },
    }),
    async (c) => {
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

        return c.json(
          {
            searchId,
            local,
            network: null,
            networkAvailable,
            errors: errors.length > 0 ? errors : undefined,
          },
          200,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json(
          {
            searchId: crypto.randomUUID(),
            local: emptyLocal,
            network: null,
            networkAvailable: false,
            errors: [`Search failed unexpectedly: ${msg}`],
          },
          500,
        );
      }
    },
  );

  // Poll network search results
  app.openapi(
    createRoute({
      method: 'get',
      path: '/{searchId}/network',
      request: {
        params: z.object({
          searchId: z.string().uuid(),
        }),
      },
      responses: {
        200: {
          content: {
            'application/json': {
              schema: NetworkSearchResponseSchema,
            },
          },
          description: 'Poll network search results',
        },
      },
    }),
    async (c) => {
      const { searchId } = c.req.valid('param');

      for (const provider of registry.getByType('network')) {
        if (provider.pollResults) {
          const canBrowse =
            'browseUser' in provider && typeof (provider as any).browseUser === 'function';
          try {
            const result = await provider.pollResults(searchId);
            return c.json({ ...result, canBrowse });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Log but don't crash the whole search, just return the error for this poll
            return c.json({
              state: 'complete',
              responseCount: 0,
              results: [],
              canBrowse,
              errors: [`Polling failed: ${msg}`],
            });
          }
        }
      }

      return c.json({ state: 'complete', responseCount: 0, results: [], canBrowse: false });
    },
  );

  // Cancel a search
  app.openapi(
    createRoute({
      method: 'put',
      path: '/{searchId}/cancel',
      request: {
        params: z.object({
          searchId: z.string().uuid(),
        }),
      },
      responses: {
        200: {
          content: {
            'application/json': {
              schema: z.object({ ok: z.boolean() }),
            },
          },
          description: 'Cancel a search',
        },
      },
    }),
    async (c) => {
      const { searchId } = c.req.valid('param');

      for (const provider of registry.getByType('network')) {
        if (provider.cancelSearch) {
          await provider.cancelSearch(searchId);
        }
      }

      return c.json({ ok: true });
    },
  );

  // Delete a search
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/{searchId}',
      request: {
        params: z.object({
          searchId: z.string().uuid(),
        }),
      },
      responses: {
        200: {
          content: {
            'application/json': {
              schema: z.object({ ok: z.boolean() }),
            },
          },
          description: 'Delete a search',
        },
      },
    }),
    async (c) => {
      const { searchId } = c.req.valid('param');

      for (const provider of registry.getByType('network')) {
        if (provider.deleteSearch) {
          await provider.deleteSearch(searchId);
        }
      }

      return c.json({ ok: true });
    },
  );

  return app;
}
