import { Hono } from 'hono';
import type { Navidrome } from '@nicotind/navidrome-client';
import type { Slskd } from '@nicotind/slskd-client';
import type { ServiceManager } from '@nicotind/service-manager';
import type { AuthEnv } from '../middleware/auth.js';

const startTime = Date.now();

export function systemRoutes(
  slskd: Slskd,
  navidrome: Navidrome,
  serviceManager: ServiceManager,
) {
  const app = new Hono<AuthEnv>();

  app.get('/status', async (c) => {
    let slskdHealthy = false;
    let slskdState = null;
    try {
      slskdState = await slskd.server.getState();
      slskdHealthy = true;
    } catch {
      // slskd not reachable
    }

    let navidromeHealthy = false;
    try {
      navidromeHealthy = await navidrome.system.ping();
    } catch {
      // navidrome not reachable
    }

    return c.json({
      nicotind: {
        version: '0.1.0',
        uptime: Math.floor((Date.now() - startTime) / 1000),
      },
      slskd: {
        healthy: slskdHealthy,
        connected: slskdState?.isConnected ?? false,
        username: slskdState?.username,
      },
      navidrome: {
        healthy: navidromeHealthy,
      },
    });
  });

  app.post('/scan', async (c) => {
    await navidrome.system.startScan();
    return c.json({ ok: true, message: 'Library scan started' });
  });

  app.get('/scan/status', async (c) => {
    const status = await navidrome.system.getScanStatus();
    return c.json(status);
  });

  app.post('/restart/:service', async (c) => {
    const service = c.req.param('service');
    if (service !== 'slskd' && service !== 'navidrome') {
      return c.json({ error: 'Unknown service. Use "slskd" or "navidrome"' }, 400);
    }

    await serviceManager.restartService(service);
    return c.json({ ok: true, message: `${service} restarted` });
  });

  app.get('/logs/:service', async (c) => {
    const service = c.req.param('service');
    const lines = Number(c.req.query('lines') ?? 100);
    const logs = await serviceManager.getLogs(service, lines);
    return c.json({ logs });
  });

  return app;
}
