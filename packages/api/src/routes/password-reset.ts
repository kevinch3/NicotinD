/**
 * Password reset links (docs/email-invitations.md, increment 2), split by
 * trust like invites: an admin issues a link under `/api/admin/password-resets`,
 * and the person it is for spends it under `/api/password-reset`, where the
 * token in the POST body is the only credential.
 *
 * Since increment 5 the admin may have the link **emailed** to the user's
 * verified address instead (`send: true`); the link is then never returned.
 */
import { Hono } from 'hono';
import { hostname } from 'node:os';
import type { Database } from 'bun:sqlite';
import type { AuthEnv } from '../middleware/auth.js';
import { signJwt } from '../middleware/auth.js';
import { recordAudit } from '../services/audit-log.js';
import { sessionVersionOf } from '../services/session-version.js';
import { linkBaseCandidates } from '../services/link-base.js';
import type { MailService } from '../services/mail/mailer.js';
import { resetEmail } from '../services/mail/templates.js';
import { notifyPasswordChanged } from '../services/password-notice.js';
import type { RemoteAccess } from '../services/tailscale.js';
import { verifiedEmailOf } from '../services/user-email.js';
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
  /** The operator's public URL — first link base, as for invites. */
  publicUrl?: () => string | null;
  /** For *Email reset link* (`send: true`); absent → that variant reads as mail off. */
  mail?: MailService | null;
  serverName?: () => string;
  now?: () => number;
}

export function passwordResetAdminRoutes(deps: PasswordResetAdminDeps) {
  const { db } = deps;
  const linkSources = { remoteAccess: deps.remoteAccess ?? null, publicUrl: deps.publicUrl };
  const now = deps.now ?? Date.now;
  const serverName = deps.serverName ?? hostname;
  const app = new Hono<AuthEnv>();

  app.use('*', async (c, next) => {
    if (c.get('user')?.role !== 'admin') {
      return c.json({ error: 'Admin access required', code: 'FORBIDDEN' }, 403);
    }
    await next();
  });

  // POST /api/admin/password-resets { userId, send? }
  //
  // Without `send`: a link the admin passes on. With `send: true`: the same
  // 24 h link, mailed to the user's verified address and never returned — the
  // response is `{ mail, expiresAt }`.
  app.post('/', async (c) => {
    const body = await c.req
      .json<{ userId?: unknown; send?: unknown }>()
      .catch(() => ({}) as { userId?: unknown; send?: unknown });
    if (typeof body.userId !== 'string' || !body.userId) {
      return c.json({ error: 'userId is required', code: 'VALIDATION_ERROR' }, 400);
    }
    const userId = body.userId;
    const actor = c.get('user');
    const urls = await linkBaseCandidates(linkSources, c.req.url);

    if (body.send === true) {
      const user = db
        .query<{ username: string }, [string]>('SELECT username FROM users WHERE id = ?')
        .get(userId);
      if (!user) return c.json({ error: 'User not found', code: 'NOT_FOUND' }, 404);
      if (!deps.mail || !deps.mail.status().enabled) {
        return c.json({ error: 'Email delivery is turned off', code: 'MAIL_NOT_CONFIGURED' }, 409);
      }
      const to = verifiedEmailOf(db, userId);
      if (!to) {
        return c.json({ error: 'This user has no verified email', code: 'NO_VERIFIED_EMAIL' }, 409);
      }
      const issued = issueResetToken(db, userId, actor.sub, ADMIN_RESET_TTL_MS, now())!;
      const base = (urls[0] ?? new URL(c.req.url).origin).replace(/\/+$/, '');
      const mail = await deps.mail.send('reset', {
        to,
        ...resetEmail({
          serverName: serverName(),
          username: user.username,
          link: `${base}/reset-password#t=${issued.token}`,
          expiresIn: '24 hours',
        }),
      });
      recordAudit(db, actor, 'user.reset-link', {
        targetKind: 'user',
        targetId: userId,
        detail: `emailed=${mail.ok}`,
      });
      return c.json({ mail, expiresAt: issued.expiresAt }, 201);
    }

    const issued = issueResetToken(db, userId, actor.sub, ADMIN_RESET_TTL_MS, now());
    if (!issued) return c.json({ error: 'User not found', code: 'NOT_FOUND' }, 404);
    recordAudit(db, actor, 'user.reset-link', { targetKind: 'user', targetId: userId });
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
  /** The "password changed" notice after a reset; absent → none is sent. */
  mail?: MailService | null;
  serverName?: () => string;
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
  const serverName = deps.serverName ?? hostname;
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
    void notifyPasswordChanged({ db, mail: deps.mail, serverName, now }, user.id);
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
