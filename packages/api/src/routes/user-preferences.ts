import { Hono } from 'hono';
import { UserPreferencesPatchSchema } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { getDatabase } from '../db.js';
import { getUserPreferences, patchUserPreferences } from '../services/user-preferences.js';

/**
 * The caller's own preferences (issue #1299): what follows them across devices.
 * Scoped to `user.sub`, no user id in the path — the same structural rule as
 * `/api/privacy`. `GET /api/auth/me` embeds the same object so app boot needs
 * no second round-trip; this group exists for the write and for a re-read.
 */
export function userPreferencesRoutes() {
  const app = new Hono<AuthEnv>();

  app.get('/preferences', (c) => {
    const user = c.get('user');
    return c.json(getUserPreferences(getDatabase(), user.sub));
  });

  app.patch('/preferences', async (c) => {
    const user = c.get('user');
    const body = await c.req.json().catch(() => null);
    const parsed = UserPreferencesPatchSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: parsed.error.issues[0]?.message ?? 'invalid preferences patch',
          code: 'VALIDATION_ERROR',
        },
        400,
      );
    }
    return c.json(patchUserPreferences(getDatabase(), user.sub, parsed.data));
  });

  return app;
}
