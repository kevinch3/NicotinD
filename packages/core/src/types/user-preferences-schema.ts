/**
 * The zod side of `user-preferences.ts`, for the API's request validation.
 * Kept out of that file so the web's initial bundle never pays for zod.
 */
import { z } from 'zod';
import { STRATEGY_IDS } from './radio-strategy.js';
import {
  HOME_VIEWS,
  PREFERENCE_LANGS,
  THEME_IDS,
  type UserPreferences,
} from './user-preferences.js';

export const UserPreferencesSchema = z
  .object({
    homeView: z.enum(HOME_VIEWS).nullable(),
    theme: z.enum(THEME_IDS).nullable(),
    followSystemTheme: z.boolean().nullable(),
    language: z.enum(PREFERENCE_LANGS).nullable(),
    radioStrategy: z.enum(STRATEGY_IDS).nullable(),
    welcomeDismissed: z.boolean(),
  })
  .strict() satisfies z.ZodType<UserPreferences>;

export const UserPreferencesPatchSchema = z
  .object({
    homeView: z.enum(HOME_VIEWS),
    theme: z.enum(THEME_IDS),
    followSystemTheme: z.boolean(),
    language: z.enum(PREFERENCE_LANGS),
    radioStrategy: z.enum(STRATEGY_IDS),
    welcomeDismissed: z.boolean(),
  })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'patch must choose something' });
