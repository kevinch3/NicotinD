import type { Database } from 'bun:sqlite';

/**
 * Admin-editable radio preferences (`app_settings.radio`), same shape and
 * store as `streaming-settings.ts`.
 *
 * `genreAffinity` is the opt-in for the learned genre axis
 * (docs/genre-affinity.md): off, radio scores genre exactly as it always has
 * (the lexical rule); on, seed and list radio consult the embedding-centroid
 * affinity for every genre pair it knows and fall back to the lexical rule
 * for the rest. Default OFF — it is a spike being measured, and the regular
 * radio must not change underneath anyone who did not ask for it.
 */
export interface RadioSettings {
  genreAffinity: boolean;
}

export const DEFAULT_RADIO_SETTINGS: RadioSettings = {
  genreAffinity: false,
};

const KEY = 'radio';

export function getRadioSettings(db: Database): RadioSettings {
  const row = db
    .query<{ value: string }, [string]>('SELECT value FROM app_settings WHERE key = ?')
    .get(KEY);
  if (!row) return { ...DEFAULT_RADIO_SETTINGS };
  try {
    const parsed = JSON.parse(row.value) as Partial<RadioSettings>;
    return {
      ...DEFAULT_RADIO_SETTINGS,
      ...(typeof parsed.genreAffinity === 'boolean' ? { genreAffinity: parsed.genreAffinity } : {}),
    };
  } catch {
    return { ...DEFAULT_RADIO_SETTINGS };
  }
}

export function setRadioSettings(db: Database, patch: Partial<RadioSettings>): RadioSettings {
  const next = { ...getRadioSettings(db), ...patch };
  db.run(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [KEY, JSON.stringify(next)],
  );
  return next;
}
