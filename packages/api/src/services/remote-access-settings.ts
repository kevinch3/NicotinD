import type { Database } from 'bun:sqlite';

export interface RemoteAccessSettings {
  /** Master switch — when on, the server publishes itself via Tailscale Funnel. */
  enabled: boolean;
}

export const DEFAULT_REMOTE_ACCESS_SETTINGS: RemoteAccessSettings = {
  enabled: false,
};

const KEY = 'remote_access';

export function getRemoteAccessSettings(db: Database): RemoteAccessSettings {
  const row = db
    .query<{ value: string }, [string]>('SELECT value FROM app_settings WHERE key = ?')
    .get(KEY);
  if (!row) return { ...DEFAULT_REMOTE_ACCESS_SETTINGS };
  try {
    return {
      ...DEFAULT_REMOTE_ACCESS_SETTINGS,
      ...(JSON.parse(row.value) as Partial<RemoteAccessSettings>),
    };
  } catch {
    return { ...DEFAULT_REMOTE_ACCESS_SETTINGS };
  }
}

export function setRemoteAccessSettings(
  db: Database,
  patch: Partial<RemoteAccessSettings>,
): RemoteAccessSettings {
  const next = { ...getRemoteAccessSettings(db), ...patch };
  db.run(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [KEY, JSON.stringify(next)],
  );
  return next;
}
