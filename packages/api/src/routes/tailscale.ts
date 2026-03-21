import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import { TailscaleService } from '../services/tailscale.js';

export function tailscaleRoutes(tailscale: TailscaleService) {
  const app = new Hono<AuthEnv>();

  // GET /api/tailscale/status
  app.get('/status', async (c) => {
    const status = await tailscale.getStatus();
    return c.json(status);
  });

  // POST /api/tailscale/connect
  app.post('/connect', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') {
      return c.json({ error: 'Only administrators can manage Tailscale' }, 403);
    }

    const { authKey } = await c.req.json<{ authKey: string }>();
    if (!authKey?.trim()) {
      return c.json({ error: 'Auth key is required' }, 400);
    }

    try {
      const status = await tailscale.connect(authKey.trim());
      return c.json(status);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed to connect' }, 500);
    }
  });

  // POST /api/tailscale/disconnect
  app.post('/disconnect', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') {
      return c.json({ error: 'Only administrators can manage Tailscale' }, 403);
    }

    await tailscale.disconnect();
    return c.json({ ok: true });
  });

  return app;
}
