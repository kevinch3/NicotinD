import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/current-user.js';
import type { RemoteAccess } from '../services/tailscale.js';

/** Admin control for Tailscale-Funnel remote access. Mounted under
 * /api/admin/remote-access, so the blanket /api/admin/* auth applies. */
export function remoteAccessRoutes(remoteAccess: RemoteAccess) {
  const app = new Hono<AuthEnv>();

  app.get('/', async (c) => {
    requireAdmin(c);
    return c.json(await remoteAccess.status());
  });

  app.post('/', async (c) => {
    requireAdmin(c);
    const body = await c.req.json<{ enabled?: boolean }>().catch(() => ({}) as { enabled?: boolean });
    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean' }, 400);
    }
    return c.json(await remoteAccess.setEnabled(body.enabled));
  });

  return app;
}
