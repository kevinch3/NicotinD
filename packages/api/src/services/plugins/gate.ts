import { createMiddleware } from 'hono/factory';
import type { AuthEnv } from '../../middleware/auth.js';
import type { PluginRegistry } from './registry.js';

/**
 * Middleware that 503s acquisition-only features (album hunt, watchlist) when no
 * enabled plugin can download — the inverse of "features appear once a plugin is
 * enabled". Apply after auth so an unauthenticated caller still gets 401.
 */
export function requireAcquisitionMiddleware(plugins: PluginRegistry) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    if (!plugins.hasCapability('download')) {
      return c.json(
        { error: 'Acquisition is disabled — enable an acquisition plugin in Settings → Plugins' },
        503,
      );
    }
    await next();
  });
}
