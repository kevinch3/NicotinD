/**
 * The signed-in user's own account security (docs/email-invitations.md,
 * increment 2). Mounted at `/api/me/account`, behind the blanket JWT auth.
 */
import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import { asRole } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { signJwt } from '../middleware/auth.js';
import { recordAudit } from '../services/audit-log.js';
import { sessionVersionOf } from '../services/session-version.js';
import { changePassword } from '../services/password-reset.js';

export interface AccountRoutesDeps {
  db: Database;
  jwtSecret: string;
  jwtExpiresIn: string;
}

export function accountRoutes(deps: AccountRoutesDeps) {
  const { db, jwtSecret, jwtExpiresIn } = deps;
  const app = new Hono<AuthEnv>();

  // PUT /api/me/account/password { currentPassword, newPassword }
  //
  // Ends every session — including this one's token — and hands back a fresh
  // token for the device that made the change, so the person stays signed in
  // here and nowhere else. A paired device keeps its deviceId.
  app.put('/password', async (c) => {
    const user = c.get('user');
    if (user.share === true) {
      return c.json({ error: 'Share sessions cannot change passwords', code: 'FORBIDDEN' }, 403);
    }
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    const result = await changePassword(db, user.sub, body);
    if (!result.ok) {
      return c.json(
        { error: result.error, code: result.code },
        result.code === 'VALIDATION_ERROR' ? 400 : 403,
      );
    }
    recordAudit(db, user, 'user.password-change', { targetKind: 'user', targetId: user.sub });
    const row = db
      .query<{ username: string; role: string }, [string]>(
        'SELECT username, role FROM users WHERE id = ?',
      )
      .get(user.sub);
    const token = await signJwt(
      {
        sub: user.sub,
        username: row?.username ?? user.username,
        role: asRole(row?.role ?? user.role),
        // Explicit: this route owns its db handle, and the bumped version is
        // exactly the one this surviving session must carry.
        tv: sessionVersionOf(db, user.sub),
        ...(user.deviceId ? { deviceId: user.deviceId } : {}),
      },
      jwtSecret,
      jwtExpiresIn,
    );
    return c.json({ token });
  });

  return app;
}
