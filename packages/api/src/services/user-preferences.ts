/**
 * Per-user preferences on `user_settings` (issue #1299): one read that folds
 * every per-user column into the shared `UserPreferences` shape, and one merge
 * write. The older per-key routes (`/auth/dismiss-welcome`,
 * `/recommendations/preferences`) write the same columns, so both doors agree.
 *
 * Reads are defensive: a value the core enumeration does not know (a legacy
 * default, a hand-edited row) comes back as null rather than as a string the
 * web would have to guard against.
 */
import type { Database } from 'bun:sqlite';
import {
  HOME_VIEWS,
  PREFERENCE_LANGS,
  STRATEGY_IDS,
  THEME_IDS,
  type UserPreferences,
  type UserPreferencesPatch,
} from '@nicotind/core';

interface Row {
  home_view: string | null;
  theme: string | null;
  follow_system_theme: number | null;
  language: string | null;
  radio_strategy: string | null;
  welcome_dismissed: number | null;
  queue_acquired: number | null;
}

function known<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

export function getUserPreferences(db: Database, userId: string): UserPreferences {
  const row = db
    .query<Row, [string]>(
      `SELECT home_view, theme, follow_system_theme, language, radio_strategy, welcome_dismissed,
              queue_acquired
       FROM user_settings WHERE user_id = ?`,
    )
    .get(userId);
  return {
    homeView: known(row?.home_view ?? null, HOME_VIEWS),
    theme: known(row?.theme ?? null, THEME_IDS),
    followSystemTheme:
      row?.follow_system_theme === null || row?.follow_system_theme === undefined
        ? null
        : row.follow_system_theme === 1,
    language: known(row?.language ?? null, PREFERENCE_LANGS),
    radioStrategy: known(row?.radio_strategy ?? null, STRATEGY_IDS),
    welcomeDismissed: (row?.welcome_dismissed ?? 0) === 1,
    queueAcquired:
      row?.queue_acquired === null || row?.queue_acquired === undefined
        ? null
        : row.queue_acquired === 1,
  };
}

const COLUMN_FOR: Record<keyof UserPreferencesPatch, string> = {
  homeView: 'home_view',
  theme: 'theme',
  followSystemTheme: 'follow_system_theme',
  language: 'language',
  radioStrategy: 'radio_strategy',
  welcomeDismissed: 'welcome_dismissed',
  queueAcquired: 'queue_acquired',
};

/** Merge `patch` into the caller's row (created on first write) and return the result. */
export function patchUserPreferences(
  db: Database,
  userId: string,
  patch: UserPreferencesPatch,
): UserPreferences {
  const columns: string[] = [];
  const values: (string | number)[] = [];
  for (const [key, value] of Object.entries(patch) as [keyof UserPreferencesPatch, unknown][]) {
    if (value === undefined) continue;
    columns.push(COLUMN_FOR[key]);
    values.push(typeof value === 'boolean' ? (value ? 1 : 0) : (value as string));
  }
  if (columns.length > 0) {
    const assignments = columns.map((c) => `${c} = excluded.${c}`).join(', ');
    db.run(
      `INSERT INTO user_settings (user_id, ${columns.join(', ')})
       VALUES (?, ${columns.map(() => '?').join(', ')})
       ON CONFLICT(user_id) DO UPDATE SET ${assignments}`,
      [userId, ...values],
    );
  }
  return getUserPreferences(db, userId);
}
