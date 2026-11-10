/**
 * The `outbox` transport: "sending" writes the message to the `mail_outbox`
 * table, where `GET /api/admin/mail/outbox` reads it back. For tests and e2e
 * only — it is selectable through `NICOTIND_MAIL_TRANSPORT=outbox` and nowhere
 * in the UI, and it is the one place a message body is ever stored.
 */
import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { MailMessage, MailResult, MailTransport } from './transport.js';

export interface OutboxMessage {
  id: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  createdAt: number;
}

/** Loose on purpose: the outbox only refuses what no real server would accept. */
const LOOKS_LIKE_ADDRESS = /^[^\s@]+@[^\s@]+$/;

export function createOutboxTransport(db: Database, now: () => number = Date.now): MailTransport {
  return {
    async send(msg: MailMessage): Promise<MailResult> {
      if (!LOOKS_LIKE_ADDRESS.test(msg.to)) {
        return { ok: false, reason: 'recipient-rejected', detail: 'outbox: not an address' };
      }
      const id = randomUUID();
      db.run(
        `INSERT INTO mail_outbox (id, recipient, subject, text, html, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, msg.to, msg.subject, msg.text, msg.html, now()],
      );
      return { ok: true, providerId: id };
    },
    async verify(): Promise<MailResult> {
      return { ok: true };
    },
  };
}

interface OutboxRow {
  id: string;
  recipient: string;
  subject: string;
  text: string;
  html: string;
  created_at: number;
}

/** Newest first; filtered to one recipient when `to` is given (e2e specs each use their own). */
export function listOutbox(
  db: Database,
  opts: { to?: string; limit?: number } = {},
): OutboxMessage[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const order = 'ORDER BY created_at DESC, rowid DESC LIMIT ?';
  const rows = opts.to
    ? db
        .query<OutboxRow, [string, number]>(
          `SELECT * FROM mail_outbox WHERE recipient = ? COLLATE NOCASE ${order}`,
        )
        .all(opts.to, limit)
    : db.query<OutboxRow, [number]>(`SELECT * FROM mail_outbox ${order}`).all(limit);
  return rows.map((r) => ({
    id: r.id,
    to: r.recipient,
    subject: r.subject,
    text: r.text,
    html: r.html,
    createdAt: r.created_at,
  }));
}
