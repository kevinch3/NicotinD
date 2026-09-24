import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import { createLogger } from '@nicotind/core';
import {
  DEFAULT_LIBRARY_FORMAT,
  LIBRARY_FORMATS,
  libraryFormat,
  type LibraryFormat,
} from './library-format.js';
import { AMBIGUOUS_CONTAINERS } from './post-download-transcode.js';
import { DEFAULT_TARGET_LUFS } from './loudness-normalize.js';

const log = createLogger('library-format-settings');

/**
 * What the library is standardized on, chosen by the operator (#1256, #1255).
 *
 * The asymmetry this closes: streaming settings have been admin-editable since
 * they were written, while the conversion that **rewrites files on disk** was
 * configurable only by someone willing to edit compose files. The reversible
 * path got the UI; the irreversible one did not.
 */
export interface LibraryFormatSettings {
  format: LibraryFormat;
  /**
   * Integrated loudness the normalize pass targets (#1255). The one library
   * setting a person changes as a matter of taste — −14 suits mixed listening,
   * −18 classical and jazz — and the only one free to change afterwards: on
   * Opus it rewrites six header bytes per file and re-runs idempotently.
   */
  targetLufs: number;
}

/** The accepted range: quieter than −24 or louder than −9 is a typo, not a taste. */
export const TARGET_LUFS_MIN = -24;
export const TARGET_LUFS_MAX = -9;

export const DEFAULT_LIBRARY_FORMAT_SETTINGS: LibraryFormatSettings = {
  format: DEFAULT_LIBRARY_FORMAT,
  targetLufs: DEFAULT_TARGET_LUFS,
};

/**
 * Validated with zod rather than hand-checked fields.
 *
 * There are two settings idioms in this repo — `TranscodeLosslessSchema`'s
 * `safeParse` and the per-field `typeof` checks in `routes/settings.ts` — and
 * this picks the first **deliberately** rather than landing a third shape. The
 * enum is built from `LIBRARY_FORMATS`, so a format added to the registry
 * becomes selectable without a second list going stale, and one removed stops
 * validating immediately.
 */
const FORMAT_IDS = Object.keys(LIBRARY_FORMATS) as [LibraryFormat, ...LibraryFormat[]];
export const LibraryFormatSettingsSchema = z.object({
  format: z.enum(FORMAT_IDS),
  // Defaulted, so a row written before this field existed still parses.
  targetLufs: z.number().min(TARGET_LUFS_MIN).max(TARGET_LUFS_MAX).default(DEFAULT_TARGET_LUFS),
});

const KEY = 'libraryFormat';

export function getLibraryFormatSettings(db: Database): LibraryFormatSettings {
  // Never throws. This is read to decide whether an Admin button is offered and
  // at the head of the conversion pass, so "nothing chosen" and "nowhere to
  // look" must both answer the default rather than taking the caller down.
  let row: { value: string } | null = null;
  try {
    row =
      db
        .query<{ value: string }, [string]>('SELECT value FROM app_settings WHERE key = ?')
        .get(KEY) ?? null;
  } catch {
    return { ...DEFAULT_LIBRARY_FORMAT_SETTINGS };
  }
  if (!row) return { ...DEFAULT_LIBRARY_FORMAT_SETTINGS };
  const parsed = LibraryFormatSettingsSchema.safeParse(safeJson(row.value));
  if (!parsed.success) {
    // A hand-edited row, or a format that existed in an older build and no
    // longer does. Falling back keeps the conversion pass runnable rather than
    // taking it down over a settings value.
    log.warn({ value: row.value }, 'unreadable library format setting; using the default');
    return { ...DEFAULT_LIBRARY_FORMAT_SETTINGS };
  }
  return parsed.data;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function setLibraryFormatSettings(
  db: Database,
  patch: Partial<LibraryFormatSettings>,
): LibraryFormatSettings {
  const next = { ...getLibraryFormatSettings(db), ...patch };
  const parsed = LibraryFormatSettingsSchema.parse(next);
  db.run(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [KEY, JSON.stringify(parsed)],
  );
  return parsed;
}

export interface FormatChangeImpact {
  /** Songs already in the proposed target format — untouched by a change. */
  alreadyTarget: number;
  /** Songs that a later conversion pass would re-encode and re-identify. */
  wouldReEncode: number;
  /** True when changing to this format is not a no-op on the current library. */
  destructive: boolean;
}

/**
 * What changing the target would cost, counted before it is allowed.
 *
 * **Why this exists rather than a plain dropdown.** The setting reads like a
 * preference and is not one on a populated library. `transcodeLibraryToFormat`
 * with `scope: 'all'` takes everything that is not already the target, so
 * flipping this queues a re-encode of the whole library — a second lossy
 * generation on every file. Worse, `songId` is derived from the relative path
 * (`library-scanner.ts`), so a new extension **re-mints every song id** and the
 * full 13-table carry runs per file.
 *
 * None of that is wrong to do deliberately; all of it is wrong to do by
 * accident from a settings page. So the count is surfaced and the caller has to
 * confirm, rather than the UI implying the choice is free.
 *
 * Counted with SQL rather than by walking the library: this runs on a page load.
 *
 * **Ambiguous-container targets (`aac`, ext `m4a`) are a deliberate exception.**
 * `suffix` alone can't tell an already-converted AAC file from an ALAC one
 * wearing the same extension (#1286), and probing every such row would break
 * the "no per-file walk on a page load" rule above. So when the target itself
 * is ambiguous, no row is counted as `alreadyTarget` — every one goes to
 * `wouldReEncode` instead. Overcounting here is the safe direction: it costs
 * an extra confirmation click, never a silently-skipped file.
 */
export function formatChangeImpact(db: Database, next: LibraryFormat): FormatChangeImpact {
  const ext = libraryFormat(next).ext;
  const total =
    db
      .query<{ n: number | null }, []>('SELECT COUNT(*) AS n FROM library_songs WHERE hidden = 0')
      .get()?.n ?? 0;
  const alreadyTarget = AMBIGUOUS_CONTAINERS.has(ext)
    ? 0
    : (db
        .query<{ n: number | null }, [string]>(
          'SELECT COUNT(*) AS n FROM library_songs WHERE hidden = 0 AND lower(suffix) = ?',
        )
        .get(ext)?.n ?? 0);
  const wouldReEncode = total - alreadyTarget;
  return { alreadyTarget, wouldReEncode, destructive: wouldReEncode > 0 };
}
