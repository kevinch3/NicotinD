import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Hono } from 'hono';
import type { NicotinDConfig } from '@nicotind/core';
import type { Navidrome } from '@nicotind/navidrome-client';
import type { ServiceManager } from '@nicotind/service-manager';
import type { AuthEnv } from '../middleware/auth.js';
import { DownloadWatcher } from '../services/download-watcher.js';
import { updateExternalSoulseekCredentials } from '../services/slskd-config.js';
import type { SlskdRef, WatcherRef } from '../index.js';

interface PersistedSecrets {
  slskdPassword: string;
  navidromePassword: string;
  jwtSecret: string;
  soulseekUsername?: string;
  soulseekPassword?: string;
  soulseekListeningPort?: number;
  soulseekEnableUPnP?: boolean;
}

function expandDir(dir: string): string {
  return dir.startsWith('~') ? join(process.env.HOME ?? '/root', dir.slice(1)) : dir;
}

function readSecrets(dataDir: string): PersistedSecrets {
  const secretsPath = join(expandDir(dataDir), 'secrets.json');
  return JSON.parse(readFileSync(secretsPath, 'utf-8'));
}

function writeSecrets(dataDir: string, secrets: PersistedSecrets): void {
  const dir = expandDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const secretsPath = join(dir, 'secrets.json');
  writeFileSync(secretsPath, JSON.stringify(secrets, null, 2), { mode: 0o600 });
}

export function settingsRoutes(
  config: NicotinDConfig,
  slskdRef: SlskdRef,
  navidrome: Navidrome,
  serviceManager: ServiceManager,
  watcherRef: WatcherRef,
) {
  const app = new Hono<AuthEnv>();
  const soulseekConfigured = () => Boolean(config.soulseek.username && config.soulseek.password);

  // GET /api/settings/soulseek — read current Soulseek config + connection status
  app.get('/soulseek', async (c) => {
    const user = c.get('user');
    const configured = soulseekConfigured();

    let connected = false;
    let username: string | null = null;

    if (slskdRef.current) {
      try {
        const state = await slskdRef.current.server.getState();
        connected = state.isConnected ?? false;
        username = state.username ?? null;
      } catch {
        // slskd not reachable
      }
    }

    // Admin gets saved username; non-admin just gets status
    if (user.role === 'admin') {
      const secrets = readSecrets(config.dataDir);
      return c.json({
        username: secrets.soulseekUsername ?? config.soulseek.username ?? '',
        listeningPort: secrets.soulseekListeningPort ?? config.soulseek.listeningPort ?? 50000,
        enableUPnP: secrets.soulseekEnableUPnP ?? config.soulseek.enableUPnP ?? true,
        configured,
        connected,
      });
    }

    return c.json({
      username: username ?? '',
      configured,
      connected,
    });
  });

  // GET /api/settings/soulseek/status — lightweight status for any user
  app.get('/soulseek/status', async (c) => {
    const configured = soulseekConfigured();
    let connected = false;
    let username: string | null = null;

    if (slskdRef.current) {
      try {
        const state = await slskdRef.current.server.getState();
        connected = state.isConnected ?? false;
        username = state.username ?? null;
      } catch {
        // not reachable
      }
    }

    return c.json({ configured, connected, username });
  });

  // PUT /api/settings/soulseek — save credentials and (re)start slskd
  app.put('/soulseek', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') {
      return c.json({ error: 'Only administrators can change Soulseek settings' }, 403);
    }

    const { username, password, listeningPort, enableUPnP } = await c.req.json<{
      username: string;
      password?: string; // Optional if updating other settings
      listeningPort?: number;
      enableUPnP?: boolean;
    }>();

    if (!username?.trim()) {
      return c.json({ error: 'Username is required' }, 400);
    }

    // 1. Persist to secrets.json
    const secrets = readSecrets(config.dataDir);
    secrets.soulseekUsername = username.trim();
    if (password?.trim()) {
      secrets.soulseekPassword = password.trim();
    }
    if (listeningPort !== undefined) {
      secrets.soulseekListeningPort = listeningPort;
    }
    if (enableUPnP !== undefined) {
      secrets.soulseekEnableUPnP = enableUPnP;
    }
    writeSecrets(config.dataDir, secrets);

    // 2. Update live config
    config.soulseek.username = username.trim();
    if (password?.trim()) {
      config.soulseek.password = password.trim();
    }
    if (listeningPort !== undefined) {
      config.soulseek.listeningPort = listeningPort;
    }
    if (enableUPnP !== undefined) {
      config.soulseek.enableUPnP = enableUPnP;
    }
    serviceManager.updateConfig(config);

    // 3. Ensure slskd binary exists (embedded mode)
    if (config.mode === 'embedded') {
      const binDir = join(expandDir(config.dataDir), 'bin');
      const slskdBin = join(binDir, 'slskd');

      if (!existsSync(slskdBin)) {
        try {
          const { execSync } = await import('node:child_process');
          execSync(`bun run ${resolve(process.cwd(), 'scripts/download-deps.ts')}`, {
            stdio: 'inherit',
          });
        } catch {
          return c.json({ error: 'Failed to download slskd binary' }, 500);
        }
      }
    }

    // 4. Update slskd
    try {
      const slskd = slskdRef.current;
      if (serviceManager.hasService('slskd')) {
        // Embedded mode: NicotinD manages the local slskd process.
        await serviceManager.restartService('slskd');
      } else {
        // External mode: push the credentials into the Dockerized slskd instance.
        if (!slskd) {
          return c.json({ error: 'Soulseek service is not available' }, 503);
        }
        const slskdPassword = password?.trim() || config.soulseek.password;
        if (!slskdPassword) {
          return c.json({ error: 'Soulseek password is required' }, 400);
        }
        await updateExternalSoulseekCredentials(slskd, username.trim(), slskdPassword);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `Failed to update slskd: ${msg}` }, 500);
    }

    // 5. (Re)create download watcher
    if (watcherRef.current) {
      watcherRef.current.stop();
    }
    watcherRef.current = new DownloadWatcher(slskdRef.current!, navidrome, {
      musicDir: config.musicDir,
      metadataFixEnabled: config.metadataFix.enabled,
      metadataFixMinScore: config.metadataFix.minScore,
    });
    watcherRef.current.start();

    // 6. Verify connection after a short delay
    let connected = false;
    let connectedUsername: string | null = null;
    try {
      await new Promise((r) => setTimeout(r, 3000));
      if (slskdRef.current) {
        const state = await slskdRef.current.server.getState();
        connected = state.isConnected ?? false;
        connectedUsername = state.username ?? null;
      }
    } catch {
      // Connection status unknown — not fatal
    }

    return c.json({
      ok: true,
      message: 'Soulseek credentials saved and service updated',
      connected,
      username: connectedUsername,
    });
  });

  // POST /api/settings/soulseek/toggle — connect or disconnect from Soulseek network
  app.post('/soulseek/toggle', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') {
      return c.json({ error: 'Only administrators can toggle the Soulseek connection' }, 403);
    }

    if (!slskdRef.current) {
      return c.json({ error: 'Soulseek is not configured' }, 503);
    }

    let state;
    try {
      state = await slskdRef.current.server.getState();
    } catch {
      return c.json({ error: 'Could not reach Soulseek service' }, 503);
    }

    if (state.isConnected) {
      await slskdRef.current.server.disconnect();
      return c.json({ connected: false });
    } else {
      await slskdRef.current.server.connect();
      return c.json({ connected: true });
    }
  });

  // GET /api/settings/shares — list configured share directories
  app.get('/shares', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') {
      return c.json({ error: 'Only administrators can manage shares' }, 403);
    }

    if (!slskdRef.current) {
      return c.json({ error: 'Soulseek is not configured' }, 503);
    }

    const dirs = await slskdRef.current.shares.list();
    return c.json({ directories: dirs.map((d) => d.path) });
  });

  // POST /api/settings/shares — add a share directory
  app.post('/shares', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') {
      return c.json({ error: 'Only administrators can manage shares' }, 403);
    }

    if (!slskdRef.current) {
      return c.json({ error: 'Soulseek is not configured' }, 503);
    }

    const { path } = await c.req.json<{ path: string }>();
    if (!path?.trim()) {
      return c.json({ error: 'path is required' }, 400);
    }

    await slskdRef.current.shares.add(path.trim());
    return c.json({ ok: true });
  });

  // DELETE /api/settings/shares/:path — remove a share directory
  app.delete('/shares/:path{.+}', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') {
      return c.json({ error: 'Only administrators can manage shares' }, 403);
    }

    if (!slskdRef.current) {
      return c.json({ error: 'Soulseek is not configured' }, 503);
    }

    const path = decodeURIComponent(c.req.param('path'));
    await slskdRef.current.shares.remove(path);
    return c.json({ ok: true });
  });

  // POST /api/settings/shares/rescan — trigger slskd share rescan
  app.post('/shares/rescan', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') {
      return c.json({ error: 'Only administrators can manage shares' }, 403);
    }

    if (!slskdRef.current) {
      return c.json({ error: 'Soulseek is not configured' }, 503);
    }

    await slskdRef.current.shares.rescan();
    return c.json({ ok: true });
  });

  return app;
}
