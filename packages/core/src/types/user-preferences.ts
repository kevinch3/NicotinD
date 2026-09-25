/**
 * Per-user preferences (issue #1299): the things one person chooses that should
 * follow them from the phone to the laptop — home view, theme, language, the
 * radio variety position, the welcome banner, and whether a track got from
 * search joins the queue when it lands (#1294).
 *
 * Every key is nullable on read: `null` means "nothing chosen on the server",
 * and the client keeps whatever the device resolved (browser language, the
 * default theme). The enumerations live here so the API validates against
 * exactly the set the web renders, rather than each side keeping its own list.
 *
 * This file is deliberately zod-free: the web imports it into its initial
 * bundle, and the validator it needs is a few lines. The zod schemas the API
 * validates request bodies with are in `user-preferences-schema.ts`.
 */
import { STRATEGY_IDS, type StrategyId } from './radio-strategy.js';

export const HOME_VIEWS = ['mosaic', 'shelves'] as const;
export type HomeView = (typeof HOME_VIEWS)[number];

export const THEME_IDS = [
  'midnight',
  'daylight',
  'warm-paper',
  'oled',
  'twilight',
  'forest',
  'eink',
] as const;
export type ThemeId = (typeof THEME_IDS)[number];

/** Languages with a catalog in the web app's `public/i18n/`. */
export const PREFERENCE_LANGS = ['en', 'es'] as const;
export type PreferenceLang = (typeof PREFERENCE_LANGS)[number];

export interface UserPreferences {
  homeView: HomeView | null;
  theme: ThemeId | null;
  followSystemTheme: boolean | null;
  language: PreferenceLang | null;
  radioStrategy: StrategyId | null;
  welcomeDismissed: boolean;
  /**
   * Whether a track or album got from search joins this device's queue when it
   * lands (#1294). `null` = never chosen, which reads as on: it is an opt-out.
   */
  queueAcquired: boolean | null;
}

/** A patch chooses; it never carries null. At least one key is required. */
export type UserPreferencesPatch = Partial<{
  [K in keyof UserPreferences]: NonNullable<UserPreferences[K]>;
}>;

export const EMPTY_USER_PREFERENCES: UserPreferences = {
  homeView: null,
  theme: null,
  followSystemTheme: null,
  language: null,
  radioStrategy: null,
  welcomeDismissed: false,
  queueAcquired: null,
};

const KEYS: readonly (keyof UserPreferences)[] = [
  'homeView',
  'theme',
  'followSystemTheme',
  'language',
  'radioStrategy',
  'welcomeDismissed',
  'queueAcquired',
];

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): v is T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v);
}

/** The opt-out reading of `queueAcquired`: never chosen means on. */
export function queueAcquiredOn(prefs: Pick<UserPreferences, 'queueAcquired'>): boolean {
  return prefs.queueAcquired !== false;
}

/**
 * Validate an unknown value (a stored mirror, a server reply) as the full
 * shape; null when any key is missing, extra, or outside its enumeration.
 */
export function parseUserPreferences(v: unknown): UserPreferences | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).some((k) => !(KEYS as readonly string[]).includes(k))) return null;
  const nullOr = <T>(x: unknown, ok: (y: unknown) => y is T): x is T | null => x === null || ok(x);
  if (!nullOr(o['homeView'], (x): x is HomeView => oneOf(x, HOME_VIEWS))) return null;
  if (!nullOr(o['theme'], (x): x is ThemeId => oneOf(x, THEME_IDS))) return null;
  if (!nullOr(o['followSystemTheme'], (x): x is boolean => typeof x === 'boolean')) return null;
  if (!nullOr(o['language'], (x): x is PreferenceLang => oneOf(x, PREFERENCE_LANGS))) return null;
  if (!nullOr(o['radioStrategy'], (x): x is StrategyId => oneOf(x, STRATEGY_IDS))) return null;
  if (typeof o['welcomeDismissed'] !== 'boolean') return null;
  // Absent reads as null: a mirror written before the key existed stays valid.
  const queueAcquired = o['queueAcquired'] ?? null;
  if (!nullOr(queueAcquired, (x): x is boolean => typeof x === 'boolean')) return null;
  return {
    homeView: o['homeView'] as HomeView | null,
    theme: o['theme'] as ThemeId | null,
    followSystemTheme: o['followSystemTheme'] as boolean | null,
    language: o['language'] as PreferenceLang | null,
    radioStrategy: o['radioStrategy'] as StrategyId | null,
    welcomeDismissed: o['welcomeDismissed'] as boolean,
    queueAcquired,
  };
}
