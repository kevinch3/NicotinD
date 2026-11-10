/**
 * Admin → Email delivery at the HTTP layer (docs/email-invitations.md,
 * increment 3): settings with a write-only password, env pinning, the test
 * send, and the outbox route that exists only under the outbox transport.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { JwtPayload } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { applySchema } from '../db.js';
import { mailAdminRoutes } from './mail.js';
import { MailService } from '../services/mail/mailer.js';
import { MailSettingsStore, readMailEnv } from '../services/mail/settings.js';
import type { MailMessage, MailResult } from '../services/mail/transport.js';

let db: Database;
let sent: MailMessage[];
let nextResult: MailResult;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  sent = [];
  nextResult = { ok: true, providerId: 'q-1' };
});

function app(
  opts: {
    env?: Record<string, string>;
    role?: 'admin' | 'user';
    funnel?: string | null;
    stubTransport?: boolean;
  } = {},
) {
  const settings = new MailSettingsStore(db, readMailEnv(opts.env ?? {}));
  const mail = new MailService({
    db,
    settings,
    transportFor:
      opts.stubTransport === false
        ? undefined
        : () => ({
            send: async (msg) => {
              sent.push(msg);
              return nextResult;
            },
            verify: async () => ({ ok: true }),
          }),
  });
  const wrap = new Hono<AuthEnv>();
  wrap.use('*', async (c, next) => {
    c.set('user', {
      sub: 'admin1',
      username: 'boss',
      role: opts.role ?? 'admin',
      iat: 0,
      exp: 0,
    } as JwtPayload);
    await next();
  });
  wrap.route(
    '/',
    mailAdminRoutes({
      db,
      mail,
      remoteAccess: { publicUrl: async () => opts.funnel ?? null },
      serverName: () => 'den',
    }),
  );
  return wrap;
}

const put = (body: unknown) => ({
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const post = (body: unknown) => ({ ...put(body), method: 'POST' });

const SMTP = {
  transport: 'smtp',
  presetId: 'mailgun',
  host: 'smtp.mailgun.org',
  port: 587,
  secure: false,
  username: 'postmaster@mg.example.com',
  fromAddress: 'music@example.com',
  fromName: 'Den',
};

function audit() {
  return db
    .query<{ action: string; detail: string | null }, []>(
      'SELECT action, detail FROM audit_log ORDER BY id',
    )
    .all();
}

describe('access', () => {
  it.each([
    ['GET', '/'],
    ['PUT', '/'],
    ['POST', '/test'],
  ])('%s %s is admin-only', async (method, path) => {
    const res = await app({ role: 'user' }).request(path, { method });
    expect(res.status).toBe(403);
  });
});

describe('GET /', () => {
  it('returns defaults, presets, usage and the link base — and no password field', async () => {
    const res = await app({ funnel: 'https://den.tail.ts.net' }).request('http://127.0.0.1:8484/');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      settings: { transport: 'off', dailyCap: 100, port: 587 },
      effectiveTransport: 'off',
      passwordSet: false,
      configurable: true,
      publicUrlConfigurable: true,
      usage: { sentToday: 0, cap: 100 },
      linkBase: 'https://den.tail.ts.net',
    });
    expect(body.presets.map((p: { id: string }) => p.id)).toEqual([
      'mailgun',
      'brevo',
      'gmail',
      'fastmail',
      'custom',
    ]);
    expect(body.settings).not.toHaveProperty('password');
  });

  it('linkBase is null when only loopback is known', async () => {
    const body = await (await app().request('http://127.0.0.1:8484/')).json();
    expect(body.linkBase).toBeNull();
  });
});

describe('PUT /', () => {
  it('saves, never echoes the password, and audits which fields changed — not their values', async () => {
    const res = await app().request('/', put({ ...SMTP, password: 'hunter2' }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('hunter2');
    const body = JSON.parse(text);
    expect(body).toMatchObject({ settings: SMTP, passwordSet: true, effectiveTransport: 'smtp' });
    const [entry] = audit();
    expect(entry!.action).toBe('mail.settings');
    expect(entry!.detail).toContain('password');
    expect(entry!.detail).not.toContain('hunter2');
    expect(entry!.detail).not.toContain('postmaster');
  });

  it('omitting the password keeps it; an empty string clears it', async () => {
    await app().request('/', put({ ...SMTP, password: 'hunter2' }));
    const kept = await (await app().request('/', put({ fromName: 'Den 2' }))).json();
    expect(kept.passwordSet).toBe(true);
    const cleared = await (await app().request('/', put({ password: '' }))).json();
    expect(cleared.passwordSet).toBe(false);
  });

  it.each([
    [{ port: 70000 }],
    [{ fromAddress: 'nope' }],
    [{ dailyCap: 0 }],
    [{ publicUrl: 'javascript:alert(1)' }],
    [{ transport: 'smtp' }],
  ])('400s on %p', async (patch) => {
    const res = await app().request('/', put(patch));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_ERROR');
    expect(audit()).toHaveLength(0);
  });

  it('409 MAIL_ENV_LOCKED when NICOTIND_MAIL_TRANSPORT pins the config', async () => {
    const res = await app({ env: { NICOTIND_MAIL_TRANSPORT: 'outbox' } }).request('/', put(SMTP));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('MAIL_ENV_LOCKED');
  });

  it('a pinned config reads back as the env, read-only', async () => {
    const body = await (
      await app({
        env: {
          NICOTIND_MAIL_TRANSPORT: 'smtp',
          NICOTIND_SMTP_HOST: 'smtp.env.example',
          NICOTIND_SMTP_PASSWORD: 'x',
        },
      }).request('/')
    ).json();
    expect(body).toMatchObject({
      configurable: false,
      publicUrlConfigurable: false,
      effectiveTransport: 'smtp',
      passwordSet: true,
      settings: { transport: 'smtp', host: 'smtp.env.example' },
    });
  });

  it('NICOTIND_PUBLIC_URL wins over a saved publicUrl and fixes linkBase', async () => {
    const a = app({ env: { NICOTIND_PUBLIC_URL: 'https://env.example.com' } });
    const body = await (
      await a.request('http://lan:8484/', put({ publicUrl: 'https://saved.example.com' }))
    ).json();
    expect(body.publicUrlConfigurable).toBe(false);
    expect(body.linkBase).toBe('https://env.example.com');
    expect(body.settings.publicUrl).toBe('');
  });

  it('a saved publicUrl becomes the link base ahead of Funnel and the request origin', async () => {
    const a = app({ funnel: 'https://den.tail.ts.net' });
    const body = await (
      await a.request('http://lan:8484/', put({ publicUrl: 'https://music.example.com/' }))
    ).json();
    expect(body.linkBase).toBe('https://music.example.com');
  });
});

describe('POST /test', () => {
  it('validates the address', async () => {
    const res = await app().request('/test', post({ to: 'not-an-email' }));
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it('refuses with reason off while mail is off (and still audits the attempt)', async () => {
    const res = await app().request('/test', post({ to: 'me@example.com' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, reason: 'off' });
    expect(audit()).toEqual([{ action: 'mail.test', detail: 'failed reason=off' }]);
  });

  it('sends the test email with a link to the base and returns the result + usage', async () => {
    await app().request('/', put({ ...SMTP, publicUrl: 'https://music.example.com' }));
    const res = await app().request('/test', post({ to: ' me@example.com ' }));
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      providerId: 'q-1',
      usage: { sentToday: 1, cap: 100 },
      linkBase: 'https://music.example.com',
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('me@example.com');
    expect(sent[0]!.subject).toContain('den');
    expect(sent[0]!.text).toContain('https://music.example.com/');
    expect(audit().at(-1)).toEqual({ action: 'mail.test', detail: 'sent' });
  });

  it('passes a transport failure reason through', async () => {
    await app().request('/', put(SMTP));
    nextResult = { ok: false, reason: 'recipient-rejected', detail: '550 no such user' };
    const body = await (await app().request('/test', post({ to: 'me@example.com' }))).json();
    expect(body).toMatchObject({
      ok: false,
      reason: 'recipient-rejected',
      detail: '550 no such user',
    });
  });
});

describe('GET /outbox', () => {
  it('does not exist unless the transport is outbox', async () => {
    expect((await app().request('/outbox')).status).toBe(404);
    await app().request('/', put(SMTP));
    expect((await app().request('/outbox')).status).toBe(404);
  });

  it('under the outbox transport, returns what a test send wrote, filtered by recipient', async () => {
    const outbox = () =>
      app({
        env: { NICOTIND_MAIL_TRANSPORT: 'outbox', NICOTIND_SMTP_FROM: 'ci@example.com' },
        stubTransport: false,
        funnel: 'https://den.tail.ts.net',
      });
    await outbox().request('/test', post({ to: 'one@example.com' }));
    await outbox().request('/test', post({ to: 'two@example.com' }));
    const one = await (await outbox().request('/outbox?to=one@example.com')).json();
    expect(one.messages).toHaveLength(1);
    expect(one.messages[0]).toMatchObject({ to: 'one@example.com' });
    expect(one.messages[0].text).toContain('https://den.tail.ts.net/');
    const all = await (await outbox().request('/outbox')).json();
    expect(all.messages).toHaveLength(2);
  });

  it('is admin-only like the rest', async () => {
    const res = await app({ env: { NICOTIND_MAIL_TRANSPORT: 'outbox' }, role: 'user' }).request(
      '/outbox',
    );
    expect(res.status).toBe(403);
  });
});
