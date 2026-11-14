/**
 * Start an email verification and mail its link (docs/email-invitations.md):
 * one path for the user's own change in Settings → Account and the admin's
 * *Assign email…*, so both send the same mail and leave `users.email` alone
 * until the link is opened.
 */
import type { Database } from 'bun:sqlite';
import type { PreferenceLang } from '@nicotind/core';
import { startEmailVerification } from '../email-verification.js';
import type { MailSendResult, MailService } from './mailer.js';
import { verifyEmail } from './templates.js';

export async function sendEmailVerification(opts: {
  db: Database;
  mail: MailService;
  userId: string;
  email: string;
  serverName: string;
  /** Where the recipient reaches the server; the link is `<linkBase>/verify-email#t=…`. */
  linkBase: string;
  lang: PreferenceLang;
  /** The admin's name when they assigned it; changes the mail's wording. */
  assignedBy?: string;
  now: number;
}): Promise<MailSendResult> {
  const { token } = startEmailVerification(opts.db, opts.userId, opts.email, opts.now);
  const row = opts.db
    .query<{ username: string }, [string]>('SELECT username FROM users WHERE id = ?')
    .get(opts.userId);
  return opts.mail.send('verify', {
    to: opts.email,
    ...verifyEmail({
      serverName: opts.serverName,
      username: row?.username ?? '',
      link: `${opts.linkBase.replace(/\/+$/, '')}/verify-email#t=${token}`,
      lang: opts.lang,
      ...(opts.assignedBy !== undefined ? { assignedBy: opts.assignedBy } : {}),
    }),
  });
}
