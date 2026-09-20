import type { Database } from 'bun:sqlite';
import type { ResolvedTranscodeLossless } from './transcode-settings.js';

/**
 * Admin-editable download-pipeline preferences (`app_settings.downloads`).
 *
 * This exists because the setting had **no runtime-writable home**. The value
 * lives in `config/default.yml` under `downloads.transcodeLossless`, and the
 * production image excludes that file (`.dockerignore`), so on prod it is
 * env-only and unsettable at runtime (#824). The onboarding wizard nonetheless
 * asks the operator whether to convert lossless downloads to Opus — and wrote
 * the answer into the *streaming* key, which governs playback-time transcoding
 * and has nothing to do with it. The toggle therefore did nothing, and every
 * FLAC was converted regardless of what the operator chose.
 *
 * The config value stays the default. A stored value overrides it, so an
 * operator's explicit choice survives a restart on a host where the config
 * file is not writable.
 *
 * `format` is deliberately not here: it is `z.enum(['opus'])` on the config
 * side, a one-member enum kept "for headroom", so there is nothing to choose.
 * → docs/download-pipeline.md
 */
export interface DownloadsSettings {
  transcodeLossless: ResolvedTranscodeLossless;
}

const KEY = 'downloads';

/** Same clamp as `TranscodeLosslessSchema` — a stored value gets no free pass. */
const MIN_BITRATE = 64;
const MAX_BITRATE = 320;

/**
 * The stored PARTIAL, not the resolved settings: an absent key means "nobody
 * chose", which is the only state that lets the configured default still move.
 * Wrongly typed or unparseable values read as absent for the same reason —
 * the dialect `radio-settings.ts` established for #1121.
 */
function readStored(db: Database): Partial<ResolvedTranscodeLossless> {
  const row = db
    .query<{ value: string }, [string]>('SELECT value FROM app_settings WHERE key = ?')
    .get(KEY);
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.value) as { transcodeLossless?: Record<string, unknown> };
    const t = parsed.transcodeLossless;
    if (!t || typeof t !== 'object') return {};
    const out: Partial<ResolvedTranscodeLossless> = {};
    if (typeof t.enabled === 'boolean') out.enabled = t.enabled;
    if (
      typeof t.bitRate === 'number' &&
      Number.isFinite(t.bitRate) &&
      t.bitRate >= MIN_BITRATE &&
      t.bitRate <= MAX_BITRATE
    ) {
      out.bitRate = Math.round(t.bitRate);
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Effective settings: the configured value, overridden by whatever the operator
 * explicitly chose. `configured` is the already-resolved config-file value from
 * `resolveTranscodeLossless`, so the schema default is baked into it.
 */
export function getDownloadsSettings(
  db: Database,
  configured: ResolvedTranscodeLossless,
): DownloadsSettings {
  return { transcodeLossless: { ...configured, ...readStored(db) } };
}

/**
 * Persist the stored partial merged with the patch, never the resolved value:
 * writing the resolved value would stamp an explicit choice for every key the
 * caller never mentioned, pinning the configured default forever (#1121).
 */
export function setDownloadsSettings(
  db: Database,
  configured: ResolvedTranscodeLossless,
  patch: Partial<ResolvedTranscodeLossless>,
): DownloadsSettings {
  const stored = { ...readStored(db) };
  if (typeof patch.enabled === 'boolean') stored.enabled = patch.enabled;
  if (
    typeof patch.bitRate === 'number' &&
    Number.isFinite(patch.bitRate) &&
    patch.bitRate >= MIN_BITRATE &&
    patch.bitRate <= MAX_BITRATE
  ) {
    stored.bitRate = Math.round(patch.bitRate);
  }
  db.run(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [KEY, JSON.stringify({ transcodeLossless: stored })],
  );
  return getDownloadsSettings(db, configured);
}
