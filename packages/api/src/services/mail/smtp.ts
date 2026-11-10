/**
 * The SMTP baseline transport (docs/email-invitations.md). Every provider speaks
 * SMTP, so this one adapter covers them all; presets only pre-fill the host.
 *
 * Built on nodemailer (zero dependencies, no install hook). One connection per
 * send — mail here is a handful of invites and resets a day, so a pool would be
 * an idle socket to keep healthy for nothing.
 */
import { createTransport } from 'nodemailer';
import { clipDetail, type MailFailure, type MailMessage, type MailResult } from './transport.js';
import type { MailTransport } from './transport.js';

export interface SmtpConfig {
  host: string;
  /** 587 = submission with STARTTLS (the default), 465 = implicit TLS. */
  port: number;
  /** Implicit TLS from the first byte (port 465). False means STARTTLS when offered. */
  secure: boolean;
  username: string;
  password: string;
  fromAddress: string;
  fromName: string;
  /**
   * Never upgrade to TLS, even when the server offers STARTTLS. Test-only: the
   * in-process fake server speaks plain SMTP. Not reachable from settings.
   */
  ignoreTLS?: boolean;
  timeouts?: Partial<SmtpTimeouts>;
}

export interface SmtpTimeouts {
  connectionMs: number;
  greetingMs: number;
  socketMs: number;
}

/**
 * Always passed: nodemailer's own defaults are minutes long (2 min to connect,
 * 10 min of socket idle), and a send must never hang the request that made it.
 */
export const SMTP_TIMEOUTS: SmtpTimeouts = {
  connectionMs: 10_000,
  greetingMs: 10_000,
  socketMs: 20_000,
};

const AUTH_CODES = new Set([530, 534, 535]);
const REJECT_CODES = new Set([550, 551, 553]);
const RATE_CODES = new Set([421, 450, 451, 452]);
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ESOCKET',
  'ECONNECTION',
  'EDNS',
]);

/**
 * Map a nodemailer error onto the provider-neutral reason. nodemailer errors
 * carry `responseCode` (the SMTP reply) and `command` (the phase it failed in),
 * and a 550 means opposite things in the two phases: refused at `MAIL FROM` the
 * server will not send *as* us, refused at `RCPT TO` it will not deliver *to*
 * them. Reply codes win over transport codes — nodemailer tags a rejected
 * envelope `EENVELOPE` whatever the reply was.
 */
export function classifySmtpError(err: unknown): MailFailure {
  if (!err || typeof err !== 'object') return 'unknown';
  const e = err as { code?: unknown; responseCode?: unknown; command?: unknown };
  const reply = typeof e.responseCode === 'number' ? e.responseCode : undefined;
  const command = typeof e.command === 'string' ? e.command.toUpperCase() : '';
  if (reply !== undefined) {
    if (AUTH_CODES.has(reply)) return 'auth';
    if (REJECT_CODES.has(reply)) {
      if (command.startsWith('MAIL')) return 'sender-rejected';
      if (command.startsWith('RCPT')) return 'recipient-rejected';
      return 'unknown';
    }
    if (RATE_CODES.has(reply)) return 'rate-limited';
  }
  const code = typeof e.code === 'string' ? e.code : '';
  if (code === 'EAUTH') return 'auth';
  if (NETWORK_CODES.has(code)) return 'unreachable';
  return 'unknown';
}

function failure(err: unknown): MailResult {
  const e = err as { response?: unknown; message?: unknown } | null;
  const raw =
    (typeof e?.response === 'string' && e.response) ||
    (typeof e?.message === 'string' && e.message) ||
    String(err);
  return { ok: false, reason: classifySmtpError(err), detail: clipDetail(raw) };
}

export function createSmtpTransport(config: SmtpConfig): MailTransport {
  const timeouts = { ...SMTP_TIMEOUTS, ...config.timeouts };
  const transporter = () =>
    createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      ignoreTLS: config.ignoreTLS ?? false,
      // With credentials on a STARTTLS port, TLS is mandatory: otherwise a
      // network attacker who strips the server's STARTTLS offer receives the
      // SMTP password in plain text. An unauthenticated local relay (a Postfix
      // on the same box) still works without TLS. `ignoreTLS` is the tests'
      // plain-text fake server, and disables this too.
      requireTLS: !config.secure && !!config.username && !(config.ignoreTLS ?? false),
      auth: config.username ? { user: config.username, pass: config.password } : undefined,
      connectionTimeout: timeouts.connectionMs,
      greetingTimeout: timeouts.greetingMs,
      socketTimeout: timeouts.socketMs,
      // Never log message bodies: they carry invite and reset links.
      logger: false,
      debug: false,
    });

  return {
    async send(msg: MailMessage): Promise<MailResult> {
      const t = transporter();
      try {
        const info = await t.sendMail({
          from: config.fromName
            ? { name: config.fromName, address: config.fromAddress }
            : config.fromAddress,
          to: msg.to,
          subject: msg.subject,
          text: msg.text,
          html: msg.html,
        });
        return { ok: true, providerId: info.messageId || undefined };
      } catch (err) {
        return failure(err);
      } finally {
        t.close();
      }
    },
    async verify(): Promise<MailResult> {
      const t = transporter();
      try {
        await t.verify();
        return { ok: true };
      } catch (err) {
        return failure(err);
      } finally {
        t.close();
      }
    },
  };
}
