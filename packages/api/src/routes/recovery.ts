/**
 * Self-service account recovery (docs/email-invitations.md, increment 5),
 * mounted beside `authRoutes` under the public `/api/auth`:
 *
 * - `GET  /recovery-status` — whether the login page offers "Forgot password?".
 * - `POST /forgot { identifier }` — a username or email; mails a 30-minute reset
 *   link to the account's **verified** address.
 * - `POST /verify-email { token }` — opens an email verification link.
 *
 * ## `/forgot` says nothing
 *
 * Every input gets the same `200 { ok: true }`: an unknown name, an account
 * with no verified email, a disabled one, recovery off, the per-account
 * throttle, an exhausted quota. The lookup always runs, an ineligible request
 * does the same token work an eligible one does, and the mail itself goes out
 * after the response (`background`), so neither the body nor the SMTP round
 * trip tells a caller whether an account exists. The one other answer, `429`,
 * comes from a global budget that never looks at the identifier.
 *
 * The emailed link never uses this request's origin — an anonymous caller picks
 * its `Host` (see `services/recovery-setting.ts`).
 */
import { Hono } from 'hono';
import { hostname } from 'node:os';
import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { recordAudit } from '../services/audit-log.js';
import { completeEmailVerification } from '../services/email-verification.js';
import { generateInviteToken, hashInviteToken } from '../services/invites.js';
import { linkBaseCandidates } from '../services/link-base.js';
import type { MailService } from '../services/mail/mailer.js';
import { resetEmail } from '../services/mail/templates.js';
import { issueResetToken } from '../services/password-reset.js';
import type { RecoverySetting } from '../services/recovery-setting.js';
import type { RemoteAccess } from '../services/tailscale.js';
import { normalizeEmail } from '../services/user-email.js';
import { createFixedWindowLimiter } from './devices.js';

const log = createLogger('recovery');

/** A self-service reset link: short, because nobody is relaying it by hand. */
export const FORGOT_RESET_TTL_MS = 30 * 60_000;
/** At most one self-service reset email per account in this window. */
export const FORGOT_PER_ACCOUNT_MS = 15 * 60_000;
/** Global budget for `/forgot`, whatever the identifier. */
export const FORGOT_GLOBAL_PER_MINUTE = 20;

export interface RecoveryRoutesDeps {
  db: Database;
  mail: MailService;
  recovery: RecoverySetting;
  remoteAccess?: Pick<RemoteAccess, 'publicUrl'> | null;
  publicUrl?: () => string | null;
  serverName?: () => string;
  now?: () => number;
  /** Where the post-response send runs; tests collect it to await. Must not reject. */
  background?: (task: Promise<void>) => void;
}

interface RecoveryCandidate {
  id: string;
  username: string;
  email: string | null;
  email_verified_at: number | null;
  status: string;
}

const VERIFY_STATUS: Record<string, 404 | 409 | 410> = {
  VERIFY_INVALID: 404,
  VERIFY_EXPIRED: 410,
  VERIFY_USED: 410,
  EMAIL_TAKEN: 409,
};

export function recoveryPublicRoutes(deps: RecoveryRoutesDeps) {
  const { db, mail, recovery } = deps;
  const now = deps.now ?? Date.now;
  const serverName = deps.serverName ?? hostname;
  const background = deps.background ?? ((task: Promise<void>) => void task);
  const linkSources = { remoteAccess: deps.remoteAccess ?? null, publicUrl: deps.publicUrl };
  const app = new Hono<AuthEnv>();

  const forgotLimiter = createFixedWindowLimiter(FORGOT_GLOBAL_PER_MINUTE, 60_000, now);
  const verifyAttempts = createFixedWindowLimiter(30, 60_000, now);
  const verifyFailures = createFixedWindowLimiter(10, 5 * 60_000, now);
  const rateLimited = { error: 'Too many attempts, try again later', code: 'RATE_LIMITED' };

  app.get('/recovery-status', (c) => c.json({ enabled: recovery.effective() }));

  /** Exact username first, then a verified address; null when none may recover. */
  function recoverableUser(identifier: string, at: number): RecoveryCandidate | null {
    if (!identifier) return null;
    const row = db
      .query<RecoveryCandidate, [string, string, string]>(
        `SELECT id, username, email, email_verified_at, COALESCE(status, 'active') AS status
         FROM users WHERE username = ? OR email = ?
         ORDER BY (username = ?) DESC LIMIT 1`,
      )
      .get(identifier, normalizeEmail(identifier), identifier);
    if (!row || row.status !== 'active' || !row.email || row.email_verified_at === null) {
      return null;
    }
    const recent = db
      .query<{ n: number }, [string, number]>(
        `SELECT COUNT(*) AS n FROM password_resets
         WHERE user_id = ? AND created_by IS NULL AND created_at > ?`,
      )
      .get(row.id, at - FORGOT_PER_ACCOUNT_MS);
    return (recent?.n ?? 0) > 0 ? null : row;
  }

  /** publicUrl → Funnel → the admin's origin when recovery was turned on. Never this request. */
  async function resetLinkBase(): Promise<string | null> {
    const stored = recovery.stored().linkBase;
    const bases = await linkBaseCandidates(linkSources, stored || 'http://127.0.0.1');
    return bases[0] ?? (stored || null);
  }

  async function sendReset(user: RecoveryCandidate, token: string): Promise<void> {
    try {
      const base = await resetLinkBase();
      if (!base) {
        log.warn({ userId: user.id }, 'no link base for a reset email; not sent');
        return;
      }
      const result = await mail.send('reset', {
        to: user.email!,
        ...resetEmail({
          serverName: serverName(),
          username: user.username,
          link: `${base.replace(/\/+$/, '')}/reset-password#t=${token}`,
          expiresIn: '30 minutes',
        }),
      });
      recordAudit(db, { sub: user.id, username: user.username }, 'user.reset-email', {
        targetKind: 'user',
        targetId: user.id,
        detail: result.ok ? 'forgot sent' : `forgot failed reason=${result.reason}`,
      });
    } catch (err) {
      log.warn({ userId: user.id, err: String(err) }, 'reset email failed');
    }
  }

  app.post('/forgot', async (c) => {
    if (!forgotLimiter.hit()) return c.json(rateLimited, 429);
    const body = await c.req
      .json<{ identifier?: unknown }>()
      .catch(() => ({}) as { identifier?: unknown });
    const identifier =
      typeof body.identifier === 'string' ? body.identifier.trim().slice(0, 254) : '';
    const at = now();
    // The lookup runs whether or not recovery is on, so "off" costs the same.
    const user = recoverableUser(identifier, at);
    if (user && recovery.effective()) {
      const issued = issueResetToken(db, user.id, null, FORGOT_RESET_TTL_MS, at);
      if (issued) background(sendReset(user, issued.token));
    } else {
      // The token work `issueResetToken` does, for nobody.
      hashInviteToken(generateInviteToken());
    }
    return c.json({ ok: true });
  });

  app.post('/verify-email', async (c) => {
    if (!verifyAttempts.hit()) return c.json(rateLimited, 429);
    const body = await c.req.json<{ token?: unknown }>().catch(() => ({}) as { token?: unknown });
    const token = typeof body.token === 'string' ? body.token : '';
    const result = completeEmailVerification(db, token, now());
    if (!result.ok) {
      if (result.code === 'VERIFY_INVALID' && !verifyFailures.hit()) {
        return c.json(rateLimited, 429);
      }
      return c.json({ error: result.code, code: result.code }, VERIFY_STATUS[result.code]);
    }
    const user = db
      .query<{ username: string }, [string]>('SELECT username FROM users WHERE id = ?')
      .get(result.userId);
    recordAudit(db, { sub: result.userId, username: user?.username }, 'user.email-verified', {
      targetKind: 'user',
      targetId: result.userId,
    });
    return c.json({ ok: true, email: result.email });
  });

  return app;
}

/**
 * Mount the recovery routes inside the auth group, so `/api/auth` stays one
 * `app.route` in index.ts — `check:route-auth` accounts for every mount call
 * there, and a second mount at the same prefix would read as one group.
 */
export function withRecovery<T extends { route: (path: string, app: Hono<AuthEnv>) => unknown }>(
  auth: T,
  recovery: Hono<AuthEnv>,
): T {
  auth.route('/', recovery);
  return auth;
}
