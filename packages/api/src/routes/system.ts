import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { NicotinDConfig } from '@nicotind/core';
import type { ServiceManager } from '@nicotind/service-manager';
import type { AuthEnv } from '../middleware/auth.js';
import type { SlskdRef } from '../index.js';

const startTime = Date.now();

export function systemRoutes(
  slskdRef: SlskdRef,
  serviceManager: ServiceManager,
  config: NicotinDConfig,
  opts: { triggerScan?: () => Promise<void> | void } = {},
) {
  const app = new Hono<AuthEnv>();
  let scanning = false;

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
    });
  });

  app.post('/scan', async (c) => {
    if (!opts.triggerScan) return c.json({ error: 'Scanner not available' }, 503);
    if (scanning) return c.json({ ok: true, message: 'Library scan already running' });
    scanning = true;
    // Fire-and-forget: the native scan walks the music dir and reconciles the
    // canonical tables; the client can poll /scan/status.
    void Promise.resolve(opts.triggerScan())
      .catch(() => {})
      .finally(() => {
        scanning = false;
      });
    return c.json({ ok: true, message: 'Library scan started' });
  });

  app.get('/scan/status', (c) => {
    return c.json({ scanning, count: 0 });
  });

  app.post('/restart/:service', async (c) => {
    const service = c.req.param('service');
    if (service !== 'slskd') {
      return c.json({ error: 'Unknown service. Use "slskd"' }, 400);
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
    const VALID_SERVICES = ['slskd', 'tailscale', 'nicotind'] as const;
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
      findProc.stderr.resume(); // drain stderr to avoid pipe buffer deadlock
      findProc.on('error', reject);
      findProc.on('close', (code) => {
        const name = out.trim().split('\n')[0]?.trim();
        if (code !== 0 || !name) reject(new Error(`No container for service: ${service}`));
        else resolve(name);
      });
    }).catch((err: Error) => {
      if (err.message.includes('not found') || (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return 'DOCKER_NOT_FOUND' as const;
      }
      return null;
    });

    if (containerName === 'DOCKER_NOT_FOUND') {
      return c.json({ error: 'Docker CLI not available in this container' }, 503);
    }

    if (!containerName) {
      return c.json({ error: `No running container for service: ${service}` }, 404);
    }

    return streamSSE(c, async (stream) => {
      const logProc = spawn('docker', ['logs', '--follow', '--tail=200', containerName], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const handleData = (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
          if (line.trim()) {
            stream.writeSSE({ data: line }).catch(() => {});
          }
        }
      };

      logProc.stdout.on('data', handleData);
      logProc.stderr.on('data', handleData);

      await new Promise<void>((resolve) => {
        logProc.on('error', resolve);
        logProc.on('close', resolve);
        stream.onAbort(() => { logProc.kill(); resolve(); });
      });
    });
  });

  return app;
}
