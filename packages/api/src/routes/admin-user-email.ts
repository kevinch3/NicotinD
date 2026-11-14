/**
 * *Assign email…* (docs/email-invitations.md, "Admin: assign an email"):
 * `PUT /api/admin/user-emails/:userId { email }`, admin-only.
 *
 * The admin names the address; the user proves it. A non-empty address starts
 * the same verification as the user's own change — a link to that address,
 * `users.email` untouched until it is opened — so a mistyped address never
 * receives this account's reset links. An empty one clears the address and
 * any pending change: the way out of a wrong address the user cannot fix.
 */
import { Hono } from 'hono';
import { hostname } from 'node:os';
import type { Database } from 'bun:sqlite';
import type { AuthEnv } from '../middleware/auth.js';
import { recordAudit } from '../services/audit-log.js';
import { cancelEmailVerification, pendingEmailOf } from '../services/email-verification.js';
import { linkBaseCandidates } from '../services/link-base.js';
import type { MailService } from '../services/mail/mailer.js';
import { mailLangOf } from '../services/mail/mail-lang.js';
import { sendEmailVerification } from '../services/mail/verify-mail.js';
import type { RemoteAccess } from '../services/tailscale.js';
import { emailTaken, parseOptionalEmail, userEmailOf } from '../services/user-email.js';

export interface AdminUserEmailDeps {
  db: Database;
  mail?: MailService | null;
  remoteAccess?: Pick<RemoteAccess, 'publicUrl'> | null;
  publicUrl?: () => string | null;
  serverName?: () => string;
  now?: () => number;
}

export function adminUserEmailRoutes(deps: AdminUserEmailDeps) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const serverName = deps.serverName ?? hostname;
  const linkSources = { remoteAccess: deps.remoteAccess ?? null, publicUrl: deps.publicUrl };
  const app = new Hono<AuthEnv>();

  app.use('*', async (c, next) => {
    if (c.get('user')?.role !== 'admin') {
      return c.json({ error: 'Admin access required', code: 'FORBIDDEN' }, 403);
    }
    await next();
  });

  const view = (userId: string) => {
    const { email, verified } = userEmailOf(db, userId);
    return { email, emailVerified: verified, pendingEmail: pendingEmailOf(db, userId, now()) };
  };

  app.put('/:userId', async (c) => {
    const userId = c.req.param('userId');
    const actor = c.get('user');
    const exists = db
      .query<{ id: string }, [string]>('SELECT id FROM users WHERE id = ?')
      .get(userId);
    if (!exists) return c.json({ error: 'User not found', code: 'NOT_FOUND' }, 404);

    const body = await c.req
      .json<Record<string, unknown>>()
      .catch((): Record<string, unknown> => ({}));
    const parsed = parseOptionalEmail(body.email);
    if (!parsed.ok) return c.json({ error: parsed.error, code: 'VALIDATION_ERROR' }, 400);

    if (parsed.email === null) {
      db.run('UPDATE users SET email = NULL, email_verified_at = NULL WHERE id = ?', [userId]);
      cancelEmailVerification(db, userId);
      recordAudit(db, actor, 'user.email-clear', { targetKind: 'user', targetId: userId });
      return c.json(view(userId));
    }
    const email = parsed.email;
    const current = userEmailOf(db, userId);
    if (current.email === email && current.verified) {
      cancelEmailVerification(db, userId);
      return c.json(view(userId));
    }
    if (!deps.mail || !deps.mail.status().enabled) {
      return c.json({ error: 'This server cannot send email', code: 'MAIL_NOT_CONFIGURED' }, 409);
    }
    if (emailTaken(db, email, userId)) {
      return c.json({ error: 'An account already uses this email', code: 'EMAIL_TAKEN' }, 409);
    }

    const bases = await linkBaseCandidates(linkSources, c.req.url);
    const mail = await sendEmailVerification({
      db,
      mail: deps.mail,
      userId,
      email,
      serverName: serverName(),
      linkBase: bases[0] ?? new URL(c.req.url).origin,
      // The user's own language; the admin's browser only when they saved none.
      lang: mailLangOf(db, userId, c.req.header('accept-language')),
      assignedBy: actor.username ?? 'Your server admin',
      now: now(),
    });
    // Whether a link went out, never where to.
    recordAudit(db, actor, 'user.email-assign', {
      targetKind: 'user',
      targetId: userId,
      detail: `emailed=${mail.ok}`,
    });
    return c.json({ ...view(userId), mail });
  });

  return app;
}
