/**
 * The one mail interface core knows (docs/email-invitations.md, "Provider-agnostic
 * by design"). Every adapter — SMTP today, an optional HTTP API later — maps its own
 * failures onto `MailFailure`, so nothing above this file ever sees a vendor code.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Why a send or verify failed, in the words the settings card translates. */
export type MailFailure =
  'auth' | 'sender-rejected' | 'recipient-rejected' | 'rate-limited' | 'unreachable' | 'unknown';

export const MAIL_FAILURES: readonly MailFailure[] = [
  'auth',
  'sender-rejected',
  'recipient-rejected',
  'rate-limited',
  'unreachable',
  'unknown',
];

export type MailResult =
  { ok: true; providerId?: string } | { ok: false; reason: MailFailure; detail: string };

export interface MailTransport {
  send(msg: MailMessage): Promise<MailResult>;
  /** Connect and authenticate without sending — "are these settings right?". */
  verify(): Promise<MailResult>;
}

/** Keep a provider's error text short enough for a log row and a UI line. */
export function clipDetail(detail: string, max = 300): string {
  const flat = detail.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
