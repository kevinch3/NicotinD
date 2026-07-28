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
        {
          error: 'Acquisition is disabled — enable an acquisition plugin in Settings → Extensions',
        },
        503,
      );
    }
    await next();
  });
}

/**
 * Deployment-wide acquisition kill-switch middleware (issue #235). When the
 * install-level `acquisitionEnabled` flag is off, the **whole** acquisition
 * module is turned off: every mounted acquisition route group hard-**404s** (as
 * if the routes don't exist — the cleanest posture for a "lightweight,
 * streaming-only" deployment, per the issue). This is orthogonal to both the
 * per-user role gate (`requireAcquirer`) and the per-plugin gate
 * (`requireAcquisitionMiddleware`): it removes the subsystem regardless of who's
 * asking or which plugins are enabled. When enabled it's a zero-cost pass-through
 * so the acquisition surface behaves exactly as before. Mount after auth so an
 * unauthenticated caller still gets 401, matching `requireAcquisitionMiddleware`.
 */
export function requireAcquisitionEnabledMiddleware(enabled: boolean) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    if (!enabled) {
      return c.json({ error: 'Acquisition is disabled on this deployment' }, 404);
    }
    await next();
  });
}
