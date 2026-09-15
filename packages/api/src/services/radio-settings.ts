import type { Database } from 'bun:sqlite';

/**
 * Admin-editable radio preferences (`app_settings.radio`), same shape and
 * store as `streaming-settings.ts`.
 *
 * `genreAffinity` is the switch for the learned genre axis
 * (docs/genre-affinity.md): on, seed and list radio consult the
 * embedding-centroid affinity for every genre pair it knows and fall back to
 * the lexical rule for the rest; off, radio scores genre exactly as it always
 * did (the lexical rule). Default ON since #1121 — calibrated and measured GO
 * on the production library in #1119 — so it is an opt-OUT.
 */
export interface RadioSettings {
  genreAffinity: boolean;
}

export const DEFAULT_RADIO_SETTINGS: RadioSettings = {
  genreAffinity: true,
};

const KEY = 'radio';

/**
 * The stored PARTIAL, not the resolved settings: an absent key means "nobody
 * chose", which is the only state a later default flip can reach. Wrongly
 * typed or unparseable values read as absent for the same reason.
 */
function readStored(db: Database): Partial<RadioSettings> {
  const row = db
    .query<{ value: string }, [string]>('SELECT value FROM app_settings WHERE key = ?')
    .get(KEY);
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.value) as Partial<RadioSettings>;
    return typeof parsed.genreAffinity === 'boolean' ? { genreAffinity: parsed.genreAffinity } : {};
  } catch {
    return {};
  }
}

export function getRadioSettings(db: Database): RadioSettings {
  return { ...DEFAULT_RADIO_SETTINGS, ...readStored(db) };
}

export function setRadioSettings(db: Database, patch: Partial<RadioSettings>): RadioSettings {
  // Persist the stored partial merged with the patch, never the resolved
  // defaults: writing those would stamp an explicit value for every key the
  // caller never mentioned, manufacturing an opt-out no admin ever asked for
  // (#1121).
  const stored = { ...readStored(db), ...patch };
  db.run(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [KEY, JSON.stringify(stored)],
  );
  return getRadioSettings(db);
}
