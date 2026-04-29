import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
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

  // GET /api/system/logs/:service/stream  — SSE, admin only
  // Streams Docker container logs when the Docker socket is available.
  app.get('/logs/:service/stream', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') {
      return c.json({ error: 'Admin only' }, 403);
    }

    const service = c.req.param('service');
    const VALID_SERVICES = ['slskd', 'navidrome', 'tailscale', 'nicotind'] as const;
    if (!(VALID_SERVICES as readonly string[]).includes(service)) {
      return c.json({ error: `Unknown service. Valid services: ${VALID_SERVICES.join(', ')}` }, 400);
    }

    const DOCKER_SOCK = '/var/run/docker.sock';

    if (!existsSync(DOCKER_SOCK)) {
      return c.json({ error: 'Docker socket not available' }, 503);
    }

    // Find container name by compose service label.
    const findProc = spawn('docker', [
      'ps',
      '--filter', `label=com.docker.compose.service=${service}`,
      '--format', '{{.Names}}',
    ]);

    const containerName = await new Promise<string>((resolve, reject) => {
      let out = '';
      findProc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      findProc.on('close', (code) => {
        const name = out.trim().split('\n')[0]?.trim();
        if (code !== 0 || !name) reject(new Error(`No container for service: ${service}`));
        else resolve(name);
      });
    }).catch(() => null);

    if (!containerName) {
      return c.json({ error: `No running container for service: ${service}` }, 404);
    }

    return streamSSE(c, async (stream) => {
      const logProc = spawn('docker', ['logs', '--follow', '--tail=200', containerName], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const sendLine = async (line: string) => {
        if (line.trim()) {
          await stream.writeSSE({ data: line });
        }
      };

      const handleData = async (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
          await sendLine(line);
        }
      };

      logProc.stdout.on('data', handleData);
      logProc.stderr.on('data', handleData);

      await new Promise<void>((resolve) => {
        logProc.on('close', resolve);
        stream.onAbort(() => { logProc.kill(); resolve(); });
      });
    });
  });

  return app;
}
