/**
 * The signed-in user's own account security (docs/email-invitations.md,
 * increments 2 and 5). Mounted at `/api/me/account`, behind the blanket JWT auth.
 *
 * - `GET /` — the account's email, whether it is verified, a pending change,
 *   and whether this server can send mail at all.
 * - `PUT /email` — start a change (a verification link to the new address) or
 *   clear it. `users.email` changes only when the link is opened, at the public
 *   `POST /api/auth/verify-email`.
 * - `PUT /password` — change your own password.
 */
import { Hono } from 'hono';
import { hostname } from 'node:os';
import type { Database } from 'bun:sqlite';
import { asRole, verifyPassword } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { signJwt } from '../middleware/auth.js';
import { recordAudit } from '../services/audit-log.js';
import {
  cancelEmailVerification,
  pendingEmailOf,
  startEmailVerification,
} from '../services/email-verification.js';
import { linkBaseCandidates } from '../services/link-base.js';
import type { MailService } from '../services/mail/mailer.js';
import { verifyEmail } from '../services/mail/templates.js';
import { notifyPasswordChanged } from '../services/password-notice.js';
import { sessionVersionOf } from '../services/session-version.js';
import { changePassword } from '../services/password-reset.js';
import type { RemoteAccess } from '../services/tailscale.js';
import { emailTaken, parseOptionalEmail, userEmailOf } from '../services/user-email.js';

export interface AccountRoutesDeps {
  db: Database;
  jwtSecret: string;
  jwtExpiresIn: string;
  /** Verification links and the "password changed" notice; absent → mail reads as off. */
  mail?: MailService | null;
  remoteAccess?: Pick<RemoteAccess, 'publicUrl'> | null;
  publicUrl?: () => string | null;
  serverName?: () => string;
  now?: () => number;
}

export function accountRoutes(deps: AccountRoutesDeps) {
  const { db, jwtSecret, jwtExpiresIn } = deps;
  const now = deps.now ?? Date.now;
  const serverName = deps.serverName ?? hostname;
  const linkSources = { remoteAccess: deps.remoteAccess ?? null, publicUrl: deps.publicUrl };
  const mailEnabled = () => deps.mail?.status().enabled ?? false;
  const app = new Hono<AuthEnv>();

  const view = (userId: string) => {
    const { email, verified } = userEmailOf(db, userId);
    return {
      email,
      emailVerified: verified,
      pendingEmail: pendingEmailOf(db, userId, now()),
      mailEnabled: mailEnabled(),
    };
  };

  async function currentPasswordOk(userId: string, password: unknown): Promise<boolean> {
    if (typeof password !== 'string' || !password) return false;
    const row = db
      .query<{ password_hash: string }, [string]>('SELECT password_hash FROM users WHERE id = ?')
      .get(userId);
    return !!row && (await verifyPassword(password, row.password_hash));
  }

  app.get('/', (c) => c.json(view(c.get('user').sub)));

  // PUT /api/me/account/email { email, currentPassword }
  //
  // The current password first: a session left open on a shared screen must not
  // be enough to point the account's recovery address somewhere else.
  app.put('/email', async (c) => {
    const user = c.get('user');
    if (user.share === true) {
      return c.json({ error: 'Share sessions cannot change the email', code: 'FORBIDDEN' }, 403);
    }
    const body = await c.req
      .json<Record<string, unknown>>()
      .catch((): Record<string, unknown> => ({}));
    if (!(await currentPasswordOk(user.sub, body.currentPassword))) {
      // 403, never 401: a wrong password must not sign the user out.
      return c.json({ error: 'Current password is incorrect', code: 'INVALID_CREDENTIALS' }, 403);
    }
    const parsed = parseOptionalEmail(body.email);
    if (!parsed.ok) return c.json({ error: parsed.error, code: 'VALIDATION_ERROR' }, 400);

    if (parsed.email === null) {
      db.run('UPDATE users SET email = NULL, email_verified_at = NULL WHERE id = ?', [user.sub]);
      cancelEmailVerification(db, user.sub);
      recordAudit(db, user, 'user.email-clear', { targetKind: 'user', targetId: user.sub });
      return c.json(view(user.sub));
    }
    const email = parsed.email;
    const current = userEmailOf(db, user.sub);
    if (current.email === email && current.verified) {
      // Already this, already proven: drop any other pending change, send nothing.
      cancelEmailVerification(db, user.sub);
      return c.json(view(user.sub));
    }
    if (!deps.mail || !mailEnabled()) {
      return c.json({ error: 'This server cannot send email', code: 'MAIL_NOT_CONFIGURED' }, 409);
    }
    if (emailTaken(db, email, user.sub)) {
      return c.json({ error: 'An account already uses this email', code: 'EMAIL_TAKEN' }, 409);
    }

    const { token } = startEmailVerification(db, user.sub, email, now());
    // A signed-in request: its origin is where this user reaches the server.
    const bases = await linkBaseCandidates(linkSources, c.req.url);
    const base = (bases[0] ?? new URL(c.req.url).origin).replace(/\/+$/, '');
    const row = db
      .query<{ username: string }, [string]>('SELECT username FROM users WHERE id = ?')
      .get(user.sub);
    const mail = await deps.mail.send('verify', {
      to: email,
      ...verifyEmail({
        serverName: serverName(),
        username: row?.username ?? user.username ?? '',
        link: `${base}/verify-email#t=${token}`,
      }),
    });
    // Whether a link went out, never where to.
    recordAudit(db, user, 'user.email-change', {
      targetKind: 'user',
      targetId: user.sub,
      detail: `emailed=${mail.ok}`,
    });
    return c.json({ ...view(user.sub), mail });
  });

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
    // Fire and log: the change has happened whatever the mail does.
    void notifyPasswordChanged({ db, mail: deps.mail, serverName, now }, user.sub);
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
