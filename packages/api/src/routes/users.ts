import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import type { ProviderRegistry } from '../services/provider-registry.js';
import { BrowseUnavailableError } from '@nicotind/core';

const parsedBrowseTimeoutMs = Number(process.env.NICOTIND_BROWSE_TIMEOUT_MS ?? 120_000);
const BROWSE_TIMEOUT_MS =
  Number.isFinite(parsedBrowseTimeoutMs) && parsedBrowseTimeoutMs > 0
    ? parsedBrowseTimeoutMs
    : 120_000;

export function usersRoutes(registry: ProviderRegistry) {
  const app = new Hono<AuthEnv>();

  app.get('/:username/browse', async (c) => {
    const username = c.req.param('username');

    const provider = registry.getBrowseProvider();
    if (!provider) {
      return c.json({ error: 'Browse not supported' }, 501);
    }

    try {
      const dirs = await Promise.race([
        provider.browseUser(username).catch((e) => {
          throw new Error(`Provider error: ${e instanceof Error ? e.message : String(e)}`);
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('TIMEOUT')), BROWSE_TIMEOUT_MS),
        ),
      ]);
      return c.json(dirs);
    } catch (err) {
      if (err instanceof BrowseUnavailableError) {
        return c.json({ error: 'Browse provider not available' }, 503);
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'TIMEOUT') {
        return c.json({ error: 'Browse request timed out' }, 504);
      }
      return c.json({ error: `Browse failed: ${msg}` }, 502);
    }
  });

  return app;
}
