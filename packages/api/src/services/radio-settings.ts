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
 *
 * `queueTarget` is how deep the client keeps the radio queue: it tops up to
 * this many tracks and refills the deficit as each one is consumed, rather
 * than draining to near-empty and then dropping a batch in (docs/radio.md
 * "A radio queue has a depth, not a batch size").
 */
export interface RadioSettings {
  genreAffinity: boolean;
  queueTarget: number;
}

export const DEFAULT_RADIO_SETTINGS: RadioSettings = {
  genreAffinity: true,
  queueTarget: 20,
};

/**
 * The band a queue depth has to sit in. The floor is the old batch size — one
 * below it and a slow refill can still run the listener into silence, which is
 * the whole failure this setting exists to end. The ceiling is `/api/radio/next`'s
 * own `count` clamp: a target above it could never be reached in one fetch, so
 * the queue would sit permanently short and re-ask on every single track.
 */
export const RADIO_QUEUE_TARGET_MIN = 5;
export const RADIO_QUEUE_TARGET_MAX = 50;

/** Is this a depth the client can actually hold? Shared by the store and the route. */
export function isValidQueueTarget(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= RADIO_QUEUE_TARGET_MIN &&
    value <= RADIO_QUEUE_TARGET_MAX
  );
}

const KEY = 'radio';

/**
 * The stored PARTIAL, not the resolved settings: an absent key means "nobody
 * chose", which is the only state a later default flip can reach. Wrongly
 * typed or unparseable values read as absent for the same reason — and each
 * key is judged on its own, so one bad value never buries a good neighbour.
 */
function readStored(db: Database): Partial<RadioSettings> {
  const row = db
    .query<{ value: string }, [string]>('SELECT value FROM app_settings WHERE key = ?')
    .get(KEY);
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.value) as Partial<RadioSettings>;
    const stored: Partial<RadioSettings> = {};
    if (typeof parsed.genreAffinity === 'boolean') stored.genreAffinity = parsed.genreAffinity;
    if (isValidQueueTarget(parsed.queueTarget)) stored.queueTarget = parsed.queueTarget;
    return stored;
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
  // (#1121). A patch key that fails its own validity rule is dropped here
  // rather than stored and ignored on the next read.
  const sanitized: Partial<RadioSettings> = {};
  if (typeof patch.genreAffinity === 'boolean') sanitized.genreAffinity = patch.genreAffinity;
  if (isValidQueueTarget(patch.queueTarget)) sanitized.queueTarget = patch.queueTarget;
  const stored = { ...readStored(db), ...sanitized };
  db.run(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [KEY, JSON.stringify(stored)],
  );
  return getRadioSettings(db);
}
