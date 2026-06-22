import { createMiddleware } from 'hono/factory';
import type { AuthEnv } from '../../middleware/auth.js';
import type { PluginRegistry } from './registry.js';

/**
 * Middleware that 503s acquisition-only features (album hunt, watchlist) when no
 * acquisition plugin is enabled at all — the inverse of "features appear once a
 * plugin is enabled". Source-agnostic: the group is reachable when *any* source
 * (Soulseek, archive.org, Spotify, …) is enabled, not only a download-capable
 * one, so the blended hunt's metadata-source lanes work without Soulseek. Each
 * source-specific sub-route self-gates further. Apply after auth so an
 * unauthenticated caller still gets 401.
 */
export function requireAcquisitionMiddleware(plugins: PluginRegistry) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    if (!plugins.hasAnyAcquisitionEnabled()) {
      return c.json(
        { error: 'Acquisition is disabled — enable an acquisition plugin in Settings → Plugins' },
        503,
      );
    }
    await next();
  });
}
