/**
 * `MailService` — the one door every email goes through (docs/email-invitations.md).
 * It refuses while mail is off, enforces the daily cap from the local send log
 * (never asked of the provider), calls the transport, and logs the outcome. The
 * log holds who and how it went — kind, recipient, status, reason, provider id
 * — and never a subject, a body or a token.
 *
 * Constructed once in `createApp` and shared: increments 4–5 send invites and
 * reset links through the same instance, so they inherit the cap and the log.
 */
import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { createOutboxTransport } from './outbox.js';
import type { MailSettingsStore, MailTransportKind } from './settings.js';
import { createSmtpTransport } from './smtp.js';
import { clipDetail, type MailFailure, type MailMessage, type MailTransport } from './transport.js';

/** What a send is for — one log vocabulary across increments. */
export type MailKind = 'test' | 'invite' | 'reset' | 'notice';

/** A transport's reasons plus the two MailService refuses with before calling one. */
export type MailSendFailure = MailFailure | 'off' | 'quota-exhausted';

export type MailSendResult =
  { ok: true; providerId?: string } | { ok: false; reason: MailSendFailure; detail: string };

export interface MailUsage {
  sentToday: number;
  cap: number;
}

export interface MailStatus {
  transport: MailTransportKind;
  enabled: boolean;
  configurable: boolean;
  usage: MailUsage;
}

const DAY_MS = 86_400_000;

/** 00:00 UTC of the day `now` falls in — the quota window. */
export function startOfUtcDay(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS;
}

export interface MailServiceDeps {
  db: Database;
  settings: MailSettingsStore;
  now?: () => number;
  /**
   * Build the transport for a send. Defaults to SMTP or the outbox per the
   * effective settings; tests inject a stub.
   */
  transportFor?: (kind: Exclude<MailTransportKind, 'off'>) => MailTransport;
}

export class MailService {
  private readonly db: Database;
  readonly settings: MailSettingsStore;
  private readonly now: () => number;
  private readonly transportFor: (kind: Exclude<MailTransportKind, 'off'>) => MailTransport;

  constructor(deps: MailServiceDeps) {
    this.db = deps.db;
    this.settings = deps.settings;
    this.now = deps.now ?? Date.now;
    this.transportFor =
      deps.transportFor ??
      ((kind) =>
        kind === 'outbox'
          ? createOutboxTransport(this.db, this.now)
          : createSmtpTransport(this.settings.smtpConfig()!));
  }

  usage(now: number = this.now()): MailUsage {
    const row = this.db
      .query<{ n: number }, [number]>(
        `SELECT COUNT(*) AS n FROM mail_send_log WHERE status = 'sent' AND created_at >= ?`,
      )
      .get(startOfUtcDay(now));
    return { sentToday: row?.n ?? 0, cap: this.settings.effective().dailyCap };
  }

  status(): MailStatus {
    const transport = this.settings.effective().transport;
    return {
      transport,
      enabled: transport !== 'off',
      configurable: this.settings.configurable(),
      usage: this.usage(),
    };
  }

  async send(kind: MailKind, msg: MailMessage): Promise<MailSendResult> {
    const now = this.now();
    const transport = this.settings.effective().transport;
    if (transport === 'off') {
      this.log(kind, msg.to, 'refused', 'off', null, now);
      return { ok: false, reason: 'off', detail: 'Email delivery is turned off' };
    }
    const { sentToday, cap } = this.usage(now);
    if (sentToday >= cap) {
      this.log(kind, msg.to, 'refused', 'quota-exhausted', null, now);
      return {
        ok: false,
        reason: 'quota-exhausted',
        detail: `Daily cap of ${cap} emails reached; it resets at 00:00 UTC`,
      };
    }
    let result: MailSendResult;
    try {
      result = await this.transportFor(transport).send(msg);
    } catch (err) {
      // A transport is meant to return, not throw; one that throws is still a failure.
      result = { ok: false, reason: 'unknown', detail: clipDetail(String(err)) };
    }
    if (result.ok) this.log(kind, msg.to, 'sent', null, result.providerId ?? null, this.now());
    else this.log(kind, msg.to, 'failed', result.reason, null, this.now());
    return result;
  }

  /** Connect and authenticate with the current settings, without sending. */
  async verify(): Promise<MailSendResult> {
    const transport = this.settings.effective().transport;
    if (transport === 'off') {
      return { ok: false, reason: 'off', detail: 'Email delivery is turned off' };
    }
    return this.transportFor(transport).verify();
  }

  private log(
    kind: MailKind,
    recipient: string,
    status: 'sent' | 'failed' | 'refused',
    reason: string | null,
    providerId: string | null,
    at: number,
  ): void {
    this.db.run(
      `INSERT INTO mail_send_log (id, kind, recipient, status, reason, provider_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), kind, recipient, status, reason, providerId, at],
    );
  }
}
