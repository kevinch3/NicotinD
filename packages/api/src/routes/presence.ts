import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import { presenceService } from '../services/presence.js';

/**
 * Presence heartbeat endpoint. Any authenticated (non-share) user reports their own
 * presence here every ~60s; the admin user list is the only consumer of the aggregate.
 * Share-token POSTs are already rejected upstream by authMiddleware.
 * See docs/presence-tracking.md.
 */
export function presenceRoutes() {
  const app = new Hono<AuthEnv>();

  // POST /heartbeat — upsert the caller's session, return immediately.
  app.post('/heartbeat', async (c) => {
    const user = c.get('user');
    const body = (await c.req.json().catch(() => ({}))) as {
      deviceId?: unknown;
      tabId?: unknown;
    };

    if (typeof body.deviceId !== 'string' || typeof body.tabId !== 'string') {
      return c.json({ error: 'deviceId and tabId are required' }, 400);
    }

    presenceService.heartbeat(user.sub, body.deviceId, body.tabId);
    return c.body(null, 204);
  });

  return app;
}
