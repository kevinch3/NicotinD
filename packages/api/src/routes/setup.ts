import { Hono } from 'hono';
import { hashPassword } from '@nicotind/core';
import type { NicotinDConfig } from '@nicotind/core';
import type { ServiceManager } from '@nicotind/service-manager';
import { getDatabase } from '../db.js';
import { signJwt } from '../middleware/auth.js';
import type { DownloadWatcher } from '../services/download-watcher.js';
import { updateExternalSoulseekCredentials } from '../services/slskd-config.js';
import type { SlskdRef, WatcherRef } from '../index.js';

interface SetupDeps {
  config: NicotinDConfig;
  slskdRef: SlskdRef;
  serviceManager: ServiceManager;
  watcherRef: WatcherRef;
  /** Builds a fully-wired download watcher (organizer + native scan hook). */
  makeWatcher: () => DownloadWatcher | null;
  saveSecretsFn: (username: string, password: string) => void;
}

export function setupRoutes({
  config,
  slskdRef,
  serviceManager,
  watcherRef,
  makeWatcher,
  saveSecretsFn,
}: SetupDeps) {
  const app = new Hono();

  // GET /api/setup/status — check if setup is needed
  app.get('/status', (c) => {
    const db = getDatabase();
    const userCount = db.query<{ count: number }, []>('SELECT COUNT(*) as count FROM users').get();
    const needsSetup = (userCount?.count ?? 0) === 0;

    return c.json({ needsSetup });
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

      if (serviceManager.hasService('slskd')) {
        // Embedded mode: NicotinD owns the slskd process.
        await serviceManager.restartService('slskd');
      } else {
        // External mode: update the Dockerized slskd instance directly.
        await updateExternalSoulseekCredentials(
          slskdRef.current!,
          body.soulseek.username.trim(),
          body.soulseek.password.trim(),
        );
      }

      if (watcherRef.current) {
        watcherRef.current.stop();
      }
      watcherRef.current = makeWatcher();
      watcherRef.current?.start();
    }

    // 3. Sign JWT for immediate login
    const token = await signJwt(
      { sub: id, username: body.admin.username.trim(), role: 'admin' },
      config.jwt.secret,
      config.jwt.expiresIn,
    );

    return c.json(
      {
        token,
        user: { id, username: body.admin.username.trim(), role: 'admin' },
      },
      201,
    );
  });

  return app;
}
