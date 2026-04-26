import { Hono } from 'hono';
import type { NicotinDConfig } from '@nicotind/core';
import type { Navidrome } from '@nicotind/navidrome-client';
import type { ServiceManager } from '@nicotind/service-manager';
import type { AuthEnv } from '../middleware/auth.js';
import type { SlskdRef } from '../index.js';

const startTime = Date.now();

export function systemRoutes(
  slskdRef: SlskdRef,
  navidrome: Navidrome,
  serviceManager: ServiceManager,
  config: NicotinDConfig,
) {
  const app = new Hono<AuthEnv>();

  app.get('/status', async (c) => {
    let slskdHealthy = false;
    let slskdState = null;
    let slskdVersion: string | undefined;
    let slskdUptime: number | undefined;
    if (slskdRef.current) {
      try {
        slskdState = await slskdRef.current.server.getState();
        slskdHealthy = true;
      } catch {
        // slskd not reachable
      }
      if (slskdHealthy) {
        try {
          const info = await slskdRef.current.application.getInfo();
          slskdVersion = info.version;
          slskdUptime = info.uptime;
        } catch {
          // /application endpoint unavailable — non-fatal
        }
      }
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
        configured: Boolean(config.soulseek.username && config.soulseek.password),
        healthy: slskdHealthy,
        connected: slskdState?.isConnected ?? false,
        username: slskdState?.username,
        version: slskdVersion,
        uptime: slskdUptime,
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

    if (!serviceManager.hasService(service)) {
      const hint =
        config.mode === 'external'
          ? `${service} is managed externally — logs are not available here.`
          : `${service} is not managed by NicotinD.`;
      return c.json({ logs: [], hint });
    }

    const logs = await serviceManager.getLogs(service, lines);
    return c.json({ logs });
  });

  return app;
}
