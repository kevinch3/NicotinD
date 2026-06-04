import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';
import type { PluginRegistry } from './registry.js';

const log = createLogger('plugin-migration');
const MARKER_KEY = 'plugins_migrated';

export interface LegacySeedConfig {
  slskdConfigured: boolean;
  ytdlpEnabled: boolean;
  spotdlEnabled: boolean;
}

/**
 * One-time migration of pre-plugin deployments. Before the plugin model, slskd
 * was active whenever credentials were set and yt-dlp/spotdl whenever enabled in
 * config. On the **first** plugin-model boot of an **existing** install (users
 * already registered) we seed those plugins enabled so the upgrade is seamless.
 *
 * A **fresh** install (no users yet) is left default-off — the compliant posture:
 * an admin must explicitly opt into acquisition in Settings → Plugins. A
 * persistent marker in `app_settings` makes this run exactly once, so a fresh
 * install that registers a user later is never retroactively auto-enabled.
 * `seedEnabled` is ON CONFLICT DO NOTHING, so an admin's own toggle always wins.
 */
export function seedLegacyAcquisitionPlugins(
  registry: PluginRegistry,
  db: Database,
  cfg: LegacySeedConfig,
): void {
  const already = db
    .query<{ value: string }, [string]>('SELECT value FROM app_settings WHERE key = ?')
    .get(MARKER_KEY);
  if (already) return;

  const userCount = db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM users').get()?.c ?? 0;
  const existingInstall = userCount > 0;

  if (existingInstall) {
    if (cfg.slskdConfigured) registry.seedEnabled('slskd', 'system-migration');
    if (cfg.ytdlpEnabled) registry.seedEnabled('ytdlp', 'system-migration');
    if (cfg.spotdlEnabled) registry.seedEnabled('spotdl', 'system-migration');
    log.info('Migrated pre-plugin install — seeded previously-active acquisition plugins enabled');
  } else {
    log.info('Fresh install — acquisition is default-off until enabled in Settings → Plugins');
  }

  db.run(`INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, '1')`, [MARKER_KEY]);
}
