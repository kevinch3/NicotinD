/**
 * Password reset links (docs/email-invitations.md, increment 2), split by
 * trust like invites: an admin issues a link under `/api/admin/password-resets`,
 * and the person it is for spends it under `/api/password-reset`, where the
 * token in the POST body is the only credential.
 */
import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { AuthEnv } from '../middleware/auth.js';
import { signJwt } from '../middleware/auth.js';
import { recordAudit } from '../services/audit-log.js';
import { sessionVersionOf } from '../services/session-version.js';
import { candidateUrls } from '../services/pairing-urls.js';
import type { RemoteAccess } from '../services/tailscale.js';
import {
  ADMIN_RESET_TTL_MS,
  completeReset,
  inspectResetToken,
  issueResetToken,
} from '../services/password-reset.js';
import { createFixedWindowLimiter } from './devices.js';

export interface PasswordResetAdminDeps {
  db: Database;
  remoteAccess?: Pick<RemoteAccess, 'publicUrl'> | null;
  now?: () => number;
}

export function passwordResetAdminRoutes(deps: PasswordResetAdminDeps) {
  const { db, remoteAccess = null } = deps;
  const now = deps.now ?? Date.now;
  const app = new Hono<AuthEnv>();

  app.use('*', async (c, next) => {
    if (c.get('user')?.role !== 'admin') {
      return c.json({ error: 'Admin access required', code: 'FORBIDDEN' }, 403);
    }
    await next();
  });

  // POST /api/admin/password-resets { userId } — a link the admin passes on.
  app.post('/', async (c) => {
    const body = await c.req.json<{ userId?: unknown }>().catch(() => ({}) as { userId?: unknown });
    if (typeof body.userId !== 'string' || !body.userId) {
      return c.json({ error: 'userId is required', code: 'VALIDATION_ERROR' }, 400);
    }
    const actor = c.get('user');
    const issued = issueResetToken(db, body.userId, actor.sub, ADMIN_RESET_TTL_MS, now());
    if (!issued) return c.json({ error: 'User not found', code: 'NOT_FOUND' }, 404);
    recordAudit(db, actor, 'user.reset-link', { targetKind: 'user', targetId: body.userId });
    const funnelUrl = remoteAccess ? await remoteAccess.publicUrl().catch(() => null) : null;
    const urls = candidateUrls({ funnelUrl, requestOrigin: new URL(c.req.url).origin });
    return c.json(
      { path: `/reset-password#t=${issued.token}`, urls, expiresAt: issued.expiresAt },
      201,
    );
  });

  return app;
}

export interface PasswordResetPublicDeps {
  db: Database;
  jwtSecret: string;
  jwtExpiresIn: string;
  now?: () => number;
}

const STATUS_FOR: Record<string, 400 | 403 | 404 | 410> = {
  VALIDATION_ERROR: 400,
  ACCOUNT_DISABLED: 403,
  RESET_INVALID: 404,
  RESET_EXPIRED: 410,
  RESET_USED: 410,
};

export function passwordResetPublicRoutes(deps: PasswordResetPublicDeps) {
  const { db, jwtSecret, jwtExpiresIn } = deps;
  const now = deps.now ?? Date.now;
  const app = new Hono<AuthEnv>();
  const attemptLimiter = createFixedWindowLimiter(30, 60_000, now);
  const failureLimiter = createFixedWindowLimiter(10, 5 * 60_000, now);
  const rateLimited = { error: 'Too many attempts, try again later', code: 'RATE_LIMITED' };

  app.post('/inspect', async (c) => {
    if (!attemptLimiter.hit()) return c.json(rateLimited, 429);
    const body = await c.req.json<{ token?: unknown }>().catch(() => ({}) as { token?: unknown });
    const result = inspectResetToken(db, typeof body.token === 'string' ? body.token : '', now());
    if (result.status === 'invalid' && !failureLimiter.hit()) return c.json(rateLimited, 429);
    return c.json(result);
  });

  app.post('/complete', async (c) => {
    if (!attemptLimiter.hit()) return c.json(rateLimited, 429);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    const result = await completeReset(db, body, now());
    if (!result.ok) {
      if (result.code === 'RESET_INVALID' && !failureLimiter.hit()) return c.json(rateLimited, 429);
      return c.json({ error: result.error, code: result.code }, STATUS_FOR[result.code]);
    }
    const { user } = result;
    recordAudit(db, { sub: user.id, username: user.username }, 'user.password-reset-link-used', {
      targetKind: 'user',
      targetId: user.id,
    });
    // Signed after the bump, so this is the one session that survives it.
    const token = await signJwt(
      { sub: user.id, username: user.username, role: user.role, tv: sessionVersionOf(db, user.id) },
      jwtSecret,
      jwtExpiresIn,
    );
    return c.json({ token, user });
  });

  return app;
}
