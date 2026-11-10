import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../../db.js';
import { capFor, MailService, resetReserve, startOfUtcDay } from './mailer.js';
import { MailSettingsStore, readMailEnv } from './settings.js';
import type { MailMessage, MailResult, MailTransport } from './transport.js';

const DAY = 86_400_000;
const MIDNIGHT = Date.UTC(2026, 10, 10);
const MSG: MailMessage = {
  to: 'friend@example.com',
  subject: 'Your invite',
  text: 'Open https://music.example.com/invite#t=SECRET-TOKEN',
  html: '<a href="https://music.example.com/invite#t=SECRET-TOKEN">Join</a>',
};

let db: Database;
let clock: number;
let sent: MailMessage[];
let nextResult: MailResult;

const stub: MailTransport = {
  async send(msg) {
    sent.push(msg);
    return nextResult;
  },
  async verify() {
    return { ok: true };
  },
};

function service(env: Record<string, string> = { NICOTIND_MAIL_TRANSPORT: 'smtp' }) {
  const settings = new MailSettingsStore(db, readMailEnv(env));
  return new MailService({ db, settings, now: () => clock, transportFor: () => stub });
}

function log() {
  return db
    .query<Record<string, unknown>, []>('SELECT * FROM mail_send_log ORDER BY created_at, rowid')
    .all();
}

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  clock = MIDNIGHT + 10 * 3_600_000;
  sent = [];
  nextResult = { ok: true, providerId: 'q-1' };
});

describe('startOfUtcDay', () => {
  it('floors to 00:00 UTC', () => {
    expect(startOfUtcDay(MIDNIGHT + 1)).toBe(MIDNIGHT);
    expect(startOfUtcDay(MIDNIGHT - 1)).toBe(MIDNIGHT - DAY);
  });
});

describe('MailService.send', () => {
  it('sends through the transport and logs who, never what', async () => {
    const result = await service().send('test', MSG);
    expect(result).toEqual({ ok: true, providerId: 'q-1' });
    expect(sent).toEqual([MSG]);
    const [row] = log();
    expect(row).toMatchObject({
      kind: 'test',
      recipient: 'friend@example.com',
      status: 'sent',
      reason: null,
      provider_id: 'q-1',
      created_at: clock,
    });
    const everything = JSON.stringify(log());
    expect(everything).not.toContain('SECRET-TOKEN');
    expect(everything).not.toContain('Your invite');
  });

  it('refuses while mail is off, without calling the transport', async () => {
    const result = await service({}).send('test', MSG);
    expect(result).toMatchObject({ ok: false, reason: 'off' });
    expect(sent).toHaveLength(0);
    expect(log()[0]).toMatchObject({ status: 'refused', reason: 'off' });
  });

  it('logs a transport failure with its reason', async () => {
    nextResult = { ok: false, reason: 'auth', detail: '535 bad credentials' };
    expect(await service().send('test', MSG)).toEqual(nextResult);
    expect(log()[0]).toMatchObject({ status: 'failed', reason: 'auth', provider_id: null });
  });

  it('turns a throwing transport into an unknown failure', async () => {
    const settings = new MailSettingsStore(db, readMailEnv({ NICOTIND_MAIL_TRANSPORT: 'smtp' }));
    const mail = new MailService({
      db,
      settings,
      now: () => clock,
      transportFor: () => ({
        send: async () => {
          throw new Error('boom');
        },
        verify: async () => ({ ok: true }),
      }),
    });
    expect(await mail.send('test', MSG)).toMatchObject({ ok: false, reason: 'unknown' });
    expect(log()[0]).toMatchObject({ status: 'failed', reason: 'unknown' });
  });

  it('stops at the daily cap with a typed quota-exhausted, then resets at 00:00 UTC', async () => {
    // A cap of 2 keeps a reserve of 1 for resets; a 'reset' may use the whole cap.
    new MailSettingsStore(db, readMailEnv({})).update({
      transport: 'smtp',
      host: 'smtp.example.com',
      fromAddress: 'music@example.com',
      dailyCap: 2,
    });
    const mail = new MailService({
      db,
      settings: new MailSettingsStore(db, readMailEnv({})),
      now: () => clock,
      transportFor: () => stub,
    });
    expect((await mail.send('test', MSG)).ok).toBe(true);
    expect((await mail.send('reset', MSG)).ok).toBe(true);
    expect(mail.usage()).toEqual({ sentToday: 2, cap: 2 });
    expect(await mail.send('reset', MSG)).toMatchObject({ ok: false, reason: 'quota-exhausted' });
    expect(sent).toHaveLength(2);
    expect(log().at(-1)).toMatchObject({ status: 'refused', reason: 'quota-exhausted' });

    clock = MIDNIGHT + DAY; // the next UTC day
    expect(mail.usage()).toEqual({ sentToday: 0, cap: 2 });
    expect((await mail.send('test', MSG)).ok).toBe(true);
  });

  it('counts only sent mail against the cap — failures and refusals are free', async () => {
    const mail = service();
    nextResult = { ok: false, reason: 'unreachable', detail: 'ECONNREFUSED' };
    await mail.send('test', MSG);
    await service({}).send('test', MSG);
    expect(mail.usage().sentToday).toBe(0);
  });

  it('counts yesterday’s sends against yesterday only', async () => {
    const mail = service();
    clock = MIDNIGHT - 1;
    await mail.send('test', MSG);
    clock = MIDNIGHT;
    expect(mail.usage(clock).sentToday).toBe(0);
    expect(mail.usage(MIDNIGHT - 2).sentToday).toBe(1);
  });
});

describe('reset headroom', () => {
  it('reserves 10% of the cap, at least 5, never the whole cap', () => {
    expect(resetReserve(100)).toBe(10);
    expect(resetReserve(1000)).toBe(100);
    expect(resetReserve(20)).toBe(5);
    expect(resetReserve(6)).toBe(5);
    expect(resetReserve(3)).toBe(2);
    expect(resetReserve(1)).toBe(0);
    expect(capFor('reset', 100)).toBe(100);
    for (const kind of ['test', 'invite', 'verify', 'notice'] as const) {
      expect(capFor(kind, 100)).toBe(90);
    }
  });

  it('refuses other kinds once only the reserve is left, while resets use the full cap', async () => {
    new MailSettingsStore(db, readMailEnv({})).update({
      transport: 'smtp',
      host: 'smtp.example.com',
      fromAddress: 'music@example.com',
      dailyCap: 10,
    });
    const mail = new MailService({
      db,
      settings: new MailSettingsStore(db, readMailEnv({})),
      now: () => clock,
      transportFor: () => stub,
    });
    // Reserve for a cap of 10: max(5, 1) = 5, so five non-reset sends.
    for (let i = 0; i < 5; i++) expect((await mail.send('invite', MSG)).ok).toBe(true);
    for (const kind of ['invite', 'verify', 'notice', 'test'] as const) {
      expect(await mail.send(kind, MSG)).toMatchObject({ ok: false, reason: 'quota-exhausted' });
    }
    for (let i = 0; i < 5; i++) expect((await mail.send('reset', MSG)).ok).toBe(true);
    expect(await mail.send('reset', MSG)).toMatchObject({ ok: false, reason: 'quota-exhausted' });
    expect(mail.usage()).toEqual({ sentToday: 10, cap: 10 });
  });
});

describe('MailService.status / verify', () => {
  it('reports the effective transport, whether it is pinned, and usage', () => {
    expect(service().status()).toEqual({
      transport: 'smtp',
      enabled: true,
      configurable: false,
      usage: { sentToday: 0, cap: 100 },
    });
    expect(service({}).status()).toMatchObject({
      transport: 'off',
      enabled: false,
      configurable: true,
    });
  });

  it('verify refuses while off and asks the transport otherwise', async () => {
    expect(await service({}).verify()).toMatchObject({ ok: false, reason: 'off' });
    expect(await service().verify()).toEqual({ ok: true });
  });

  it('the default factory writes to the outbox when the env pins it', async () => {
    const mail = new MailService({
      db,
      settings: new MailSettingsStore(db, readMailEnv({ NICOTIND_MAIL_TRANSPORT: 'outbox' })),
      now: () => clock,
    });
    expect((await mail.send('test', MSG)).ok).toBe(true);
    expect(db.query('SELECT recipient FROM mail_outbox').all()).toEqual([
      { recipient: 'friend@example.com' },
    ]);
  });
});
