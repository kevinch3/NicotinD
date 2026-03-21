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

    const { username, password } = await c.req.json<{ username: string; password: string }>();
    if (!username?.trim() || !password?.trim()) {
      return c.json({ error: 'Username and password are required' }, 400);
    }

    // 1. Persist to secrets.json
    const secrets = readSecrets(config.dataDir);
    secrets.soulseekUsername = username.trim();
    secrets.soulseekPassword = password.trim();
    writeSecrets(config.dataDir, secrets);

    // 2. Update live config
    config.soulseek.username = username.trim();
    config.soulseek.password = password.trim();
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
        await updateExternalSoulseekCredentials(slskd, username.trim(), password.trim());
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

    return c.json({ ok: true, message: 'Soulseek credentials saved and service updated' });
  });

  return app;
}
