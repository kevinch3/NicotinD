import { Hono } from 'hono';
import { hashPassword } from '@nicotind/core';
import type { NicotinDConfig } from '@nicotind/core';
import { Slskd } from '@nicotind/slskd-client';
import type { Navidrome } from '@nicotind/navidrome-client';
import type { ServiceManager } from '@nicotind/service-manager';
import { getDatabase } from '../db.js';
import { signJwt } from '../middleware/auth.js';
import { TailscaleService } from '../services/tailscale.js';
import { DownloadWatcher } from '../services/download-watcher.js';
import type { SlskdRef, WatcherRef } from '../index.js';

interface SetupDeps {
  config: NicotinDConfig;
  slskdRef: SlskdRef;
  navidrome: Navidrome;
  serviceManager: ServiceManager;
  watcherRef: WatcherRef;
  tailscale: TailscaleService;
  saveSecretsFn: (username: string, password: string) => void;
}

export function setupRoutes({
  config,
  slskdRef,
  navidrome,
  serviceManager,
  watcherRef,
  tailscale,
  saveSecretsFn,
}: SetupDeps) {
  const app = new Hono();

  // GET /api/setup/status — check if setup is needed
  app.get('/status', async (c) => {
    const db = getDatabase();
    const userCount = db.query<{ count: number }, []>('SELECT COUNT(*) as count FROM users').get();
    const needsSetup = (userCount?.count ?? 0) === 0;

    const tsStatus = await tailscale.getStatus();

    return c.json({
      needsSetup,
      tailscale: tsStatus,
    });
  });

  // POST /api/setup/complete — create admin + configure services
  app.post('/complete', async (c) => {
    const db = getDatabase();

    // Guard: only works when no users exist
    const userCount = db.query<{ count: number }, []>('SELECT COUNT(*) as count FROM users').get();
    if ((userCount?.count ?? 0) > 0) {
      return c.json({ error: 'Setup already completed' }, 400);
    }

    const body = await c.req.json<{
      admin: { username: string; password: string };
      soulseek?: { username: string; password: string };
      tailscale?: { authKey: string };
    }>();

    // Validate admin credentials
    if (!body.admin?.username?.trim() || !body.admin?.password?.trim()) {
      return c.json({ error: 'Admin username and password are required' }, 400);
    }

    // 1. Create admin user
    const id = crypto.randomUUID();
    const passwordHash = await hashPassword(body.admin.password);
    db.query('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(
      id,
      body.admin.username.trim(),
      passwordHash,
      'admin',
    );
    db.query('INSERT INTO user_settings (user_id) VALUES (?)').run(id);

    // 2. Configure Soulseek (optional)
    if (body.soulseek?.username?.trim() && body.soulseek?.password?.trim()) {
      saveSecretsFn(body.soulseek.username.trim(), body.soulseek.password.trim());

      config.soulseek.username = body.soulseek.username.trim();
      config.soulseek.password = body.soulseek.password.trim();
      serviceManager.updateConfig(config);

      // Create slskd client
      slskdRef.current = new Slskd({
        baseUrl: config.slskd.url,
        username: config.slskd.username,
        password: config.slskd.password,
      });

      // Create download watcher
      if (watcherRef.current) watcherRef.current.stop();
      watcherRef.current = new DownloadWatcher(slskdRef.current, navidrome, {
        musicDir: config.musicDir,
        metadataFixEnabled: config.metadataFix.enabled,
        metadataFixMinScore: config.metadataFix.minScore,
      });
      watcherRef.current.start();
    }

    // 3. Connect Tailscale (optional)
    let tsStatus = await tailscale.getStatus();
    if (body.tailscale?.authKey?.trim()) {
      try {
        tsStatus = await tailscale.connect(body.tailscale.authKey.trim());
      } catch {
        // Non-fatal — setup still succeeds, user can retry from Settings
      }
    }

    // 4. Sign JWT for immediate login
    const token = await signJwt(
      { sub: id, username: body.admin.username.trim(), role: 'admin' },
      config.jwt.secret,
      config.jwt.expiresIn,
    );

    return c.json(
      {
        token,
        user: { id, username: body.admin.username.trim(), role: 'admin' },
        tailscale: tsStatus,
      },
      201,
    );
  });

  return app;
}
