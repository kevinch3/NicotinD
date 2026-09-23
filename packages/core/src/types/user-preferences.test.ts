import { describe, expect, it } from 'bun:test';
import {
  EMPTY_USER_PREFERENCES,
  HOME_VIEWS,
  PREFERENCE_LANGS,
  THEME_IDS,
  parseUserPreferences,
} from './user-preferences.js';
import { UserPreferencesPatchSchema, UserPreferencesSchema } from './user-preferences-schema.js';

describe('UserPreferencesSchema', () => {
  it('accepts every key at null (nothing chosen on the server yet)', () => {
    expect(UserPreferencesSchema.parse(EMPTY_USER_PREFERENCES)).toEqual(EMPTY_USER_PREFERENCES);
  });

  it('accepts a fully chosen set', () => {
    const full = {
      homeView: 'shelves',
      theme: 'eink',
      followSystemTheme: true,
      language: 'es',
      radioStrategy: 'similar',
      welcomeDismissed: true,
    } as const;
    expect(UserPreferencesSchema.parse(full)).toEqual(full);
  });

  it('exposes the enumerations the web derives its own types from', () => {
    expect(HOME_VIEWS).toEqual(['mosaic', 'shelves']);
    expect(THEME_IDS).toContain('midnight');
    expect(THEME_IDS).toHaveLength(7);
    expect(PREFERENCE_LANGS).toEqual(['en', 'es']);
  });
});

describe('UserPreferencesPatchSchema', () => {
  it('accepts a partial body', () => {
    expect(UserPreferencesPatchSchema.parse({ homeView: 'mosaic' })).toEqual({
      homeView: 'mosaic',
    });
  });

  it('rejects an unknown key rather than dropping it silently', () => {
    expect(UserPreferencesPatchSchema.safeParse({ colour: 'red' }).success).toBe(false);
  });

  it('rejects a value outside its enumeration', () => {
    expect(UserPreferencesPatchSchema.safeParse({ theme: 'neon' }).success).toBe(false);
    expect(UserPreferencesPatchSchema.safeParse({ language: 'fr' }).success).toBe(false);
    expect(UserPreferencesPatchSchema.safeParse({ radioStrategy: 'wild' }).success).toBe(false);
  });

  it('rejects null in a patch: a patch chooses, it never un-chooses', () => {
    expect(UserPreferencesPatchSchema.safeParse({ theme: null }).success).toBe(false);
  });

  it('rejects an empty patch', () => {
    expect(UserPreferencesPatchSchema.safeParse({}).success).toBe(false);
  });
});

// The zod-free validator the web uses on its mirror and on server replies.
describe('parseUserPreferences', () => {
  it('accepts the empty and the fully chosen shapes', () => {
    expect(parseUserPreferences(EMPTY_USER_PREFERENCES)).toEqual(EMPTY_USER_PREFERENCES);
    const full = {
      homeView: 'shelves',
      theme: 'eink',
      followSystemTheme: true,
      language: 'es',
      radioStrategy: 'similar',
      welcomeDismissed: true,
    };
    expect(parseUserPreferences(full)).toEqual(full as never);
  });

  it('returns null for a missing key, an extra key or a value outside its enumeration', () => {
    expect(parseUserPreferences({ ...EMPTY_USER_PREFERENCES, theme: 'neon' })).toBeNull();
    expect(parseUserPreferences({ ...EMPTY_USER_PREFERENCES, extra: 1 })).toBeNull();
    const missing: Partial<typeof EMPTY_USER_PREFERENCES> = { ...EMPTY_USER_PREFERENCES };
    delete missing.welcomeDismissed;
    expect(parseUserPreferences(missing)).toBeNull();
    expect(parseUserPreferences('nope')).toBeNull();
    expect(parseUserPreferences(null)).toBeNull();
  });

  it('agrees with the zod schema on what is valid', () => {
    const sample = { ...EMPTY_USER_PREFERENCES, language: 'es', followSystemTheme: false };
    expect(parseUserPreferences(sample)).toEqual(UserPreferencesSchema.parse(sample));
  });
});
