import type { Database } from 'bun:sqlite';

/**
 * Addon configuration: env vars are the deployment floor; host-pushed config
 * (PUT /addon/v1/config) is persisted in `addon_config` and overrides env for
 * the keys it carries. Core stays the source of truth — this copy exists so
 * the addon container survives recreation without waiting for a push.
 */
export interface AddonConfig {
  /** Bearer the host must present (env-only — never host-pushed). */
  token: string;
  slskdUrl: string;
  slskdUsername: string;
  slskdPassword: string;
  soulseekUsername: string;
  soulseekPassword: string;
  /** Where slskd lands completed downloads (transfer→file resolution). */
  downloadsDir: string;
  /** Read-only music-dir mount, shared out to the Soulseek network. */
  musicDir: string;
}

const PUSHABLE_KEYS = [
  'slskdUrl',
  'slskdUsername',
  'slskdPassword',
  'soulseekUsername',
  'soulseekPassword',
  'downloadsDir',
  'musicDir',
] as const;
type PushableKey = (typeof PUSHABLE_KEYS)[number];

export function readStoredConfig(db: Database): Partial<Record<PushableKey, string>> {
  const rows = db
    .query<{ key: string; value: string }, []>(`SELECT key, value FROM addon_config`)
    .all();
  const out: Partial<Record<PushableKey, string>> = {};
  for (const row of rows) {
    if ((PUSHABLE_KEYS as readonly string[]).includes(row.key)) {
      out[row.key as PushableKey] = row.value;
    }
  }
  return out;
}

/** Persist the host-pushed config (unknown keys ignored, never fatal). */
export function storeConfig(db: Database, pushed: Record<string, unknown>): void {
  for (const key of PUSHABLE_KEYS) {
    const value = pushed[key];
    if (typeof value === 'string') {
      db.run(
        `INSERT INTO addon_config (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [key, value],
      );
    }
  }
}

export function resolveConfig(
  db: Database,
  env: Record<string, string | undefined> = process.env,
): AddonConfig {
  const stored = readStoredConfig(db);
  return {
    token: env.SLSKD_ADDON_TOKEN ?? '',
    slskdUrl: stored.slskdUrl ?? env.SLSKD_ADDON_SLSKD_URL ?? 'http://localhost:5030',
    slskdUsername: stored.slskdUsername ?? env.SLSKD_ADDON_SLSKD_USERNAME ?? 'slskd',
    slskdPassword: stored.slskdPassword ?? env.SLSKD_ADDON_SLSKD_PASSWORD ?? 'slskd',
    soulseekUsername: stored.soulseekUsername ?? env.SLSKD_ADDON_SOULSEEK_USERNAME ?? '',
    soulseekPassword: stored.soulseekPassword ?? env.SLSKD_ADDON_SOULSEEK_PASSWORD ?? '',
    downloadsDir: stored.downloadsDir ?? env.SLSKD_ADDON_DOWNLOADS_DIR ?? 'data/downloads',
    musicDir: stored.musicDir ?? env.SLSKD_ADDON_MUSIC_DIR ?? '',
  };
}
