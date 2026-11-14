/**
 * "Your password was changed" (docs/email-invitations.md, increment 5): after
 * every password write — the user's own change, a reset link, the admin's
 * *Set password…* — a short notice to the account's **verified** address, so
 * someone who did not make the change hears about it.
 *
 * Fire and log: a password change has already happened when this runs, and a
 * mail that fails, is refused (mail off, quota) or throws must never turn it
 * into an error. Callers `void` the promise; it never rejects.
 */
import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';
import type { MailService } from './mail/mailer.js';
import { passwordChangedEmail } from './mail/templates.js';
import { mailLangOf } from './mail/mail-lang.js';
import { verifiedEmailOf } from './user-email.js';

const log = createLogger('password-notice');

export interface PasswordNoticeDeps {
  db: Database;
  mail?: MailService | null;
  serverName: () => string;
  now?: () => number;
}

/** Resolves to whether a notice was sent; never rejects. */
export async function notifyPasswordChanged(
  deps: PasswordNoticeDeps,
  userId: string,
  /** The request that changed it: its language words the notice when the user saved none. */
  acceptLanguage?: string | null,
): Promise<boolean> {
  try {
    const { db, mail } = deps;
    if (!mail || !mail.status().enabled) return false;
    const to = verifiedEmailOf(db, userId);
    if (!to) return false;
    const user = db
      .query<{ username: string }, [string]>('SELECT username FROM users WHERE id = ?')
      .get(userId);
    if (!user) return false;
    const result = await mail.send('notice', {
      to,
      ...passwordChangedEmail({
        serverName: deps.serverName(),
        username: user.username,
        at: (deps.now ?? Date.now)(),
        lang: mailLangOf(db, userId, acceptLanguage),
      }),
    });
    if (!result.ok) log.warn({ userId, reason: result.reason }, 'password-changed notice not sent');
    return result.ok;
  } catch (err) {
    log.warn({ userId, err: String(err) }, 'password-changed notice failed');
    return false;
  }
}
