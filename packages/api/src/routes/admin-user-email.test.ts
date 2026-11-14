/**
 * *Assign email…* at the HTTP layer: the admin names an address, the user's
 * inbox proves it. `users.email` changes only when the link is opened, so a
 * typo never receives this account's reset links.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { JwtPayload } from '@nicotind/core';
import { applySchema } from '../db.js';
import type { AuthEnv } from '../middleware/auth.js';
import { adminUserEmailRoutes } from './admin-user-email.js';
import { completeEmailVerification } from '../services/email-verification.js';
import { MailService } from '../services/mail/mailer.js';
import { MailSettingsStore, readMailEnv } from '../services/mail/settings.js';
import type { MailMessage, MailResult } from '../services/mail/transport.js';

const HOST = 'http://music.example.com';
let db: Database;
let clock: number;
let sent: MailMessage[];
let nextResult: MailResult;

function addUser(id: string, username: string, role = 'user', email?: string) {
  db.run(
    'INSERT INTO users (id, username, password_hash, role, email, email_verified_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, username, 'x', role, email ?? null, email ? 1 : null],
  );
}

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  clock = Date.UTC(2026, 10, 14, 12);
  sent = [];
  nextResult = { ok: true, providerId: 'q-1' };
  addUser('admin1', 'boss', 'admin');
  addUser('u1', 'sam');
  addUser('u2', 'ana', 'user', 'ana@example.com');
});

function mailer(on = true) {
  return new MailService({
    db,
    settings: new MailSettingsStore(
      db,
      readMailEnv({ NICOTIND_MAIL_TRANSPORT: on ? 'smtp' : 'off' }),
    ),
    now: () => clock,
    transportFor: () => ({
      send: async (msg) => {
        sent.push(msg);
        return nextResult;
      },
      verify: async () => ({ ok: true }),
    }),
  });
}

function app(opts: { role?: string; mail?: MailService | null } = {}) {
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
    '/api/admin/user-emails',
    adminUserEmailRoutes({
      db,
      mail: opts.mail === undefined ? mailer() : opts.mail,
      now: () => clock,
      serverName: () => 'den',
    }),
  );
  return wrap;
}

const put = (a: Hono<AuthEnv>, userId: string, email: unknown, headers = {}) =>
  a.request(`${HOST}/api/admin/user-emails/${userId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ email }),
  });

const tokenIn = (text: string) => text.match(/verify-email#t=([\w-]+)/)?.[1] ?? null;
const userRow = (id: string) =>
  db.query('SELECT email, email_verified_at FROM users WHERE id = ?').get(id);
const audit = () =>
  db
    .query<{ action: string; detail: string | null }, []>(
      'SELECT action, detail FROM audit_log ORDER BY id',
    )
    .all();

describe('PUT /api/admin/user-emails/:userId', () => {
  it('mails a link to the address and leaves the account alone until it is opened', async () => {
    const res = await put(app(), 'u1', ' Sam@Example.com ');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      email: null,
      emailVerified: false,
      pendingEmail: 'sam@example.com',
      mail: { ok: true },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('sam@example.com');
    expect(sent[0]!.text).toContain('boss added this address to your account');
    expect(userRow('u1')).toEqual({ email: null, email_verified_at: null });

    const token = tokenIn(sent[0]!.text)!;
    clock += 1000;
    expect(completeEmailVerification(db, token, clock)).toMatchObject({ ok: true });
    expect(userRow('u1')).toEqual({ email: 'sam@example.com', email_verified_at: clock });
  });

  it('keeps a verified address until the new one is confirmed', async () => {
    await put(app(), 'u2', 'ana@new.example.com');
    expect(userRow('u2')).toEqual({ email: 'ana@example.com', email_verified_at: 1 });
  });

  it('writes the mail in the user’s saved language, else the admin’s browser', async () => {
    await put(app(), 'u1', 'sam@example.com', { 'Accept-Language': 'es-AR' });
    expect(sent[0]!.subject).toBe('Confirma tu correo para den');
    expect(sent[0]!.text).toContain('boss agregó esta dirección a tu cuenta');

    db.run("INSERT INTO user_settings (user_id, language) VALUES ('u2', 'en')");
    await put(app(), 'u2', 'ana@new.example.com', { 'Accept-Language': 'es-AR' });
    expect(sent[1]!.subject).toBe('Confirm your email for den');
  });

  it('audits whether it was mailed, never the address', async () => {
    await put(app(), 'u1', 'sam@example.com');
    expect(audit()).toEqual([{ action: 'user.email-assign', detail: 'emailed=true' }]);
    expect(JSON.stringify(audit())).not.toContain('example.com');
  });

  it('reports a failed send and keeps the pending change, so the admin can retry', async () => {
    nextResult = { ok: false, reason: 'auth', detail: '535' };
    const res = await put(app(), 'u1', 'sam@example.com');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      pendingEmail: 'sam@example.com',
      mail: { ok: false, reason: 'auth' },
    });
    expect(audit()[0]).toEqual({ action: 'user.email-assign', detail: 'emailed=false' });
  });

  it('an empty address clears the email and any pending change', async () => {
    await put(app(), 'u2', 'ana@new.example.com');
    const res = await put(app(), 'u2', '');
    expect(await res.json()).toEqual({ email: null, emailVerified: false, pendingEmail: null });
    expect(audit().map((r) => r.action)).toEqual(['user.email-assign', 'user.email-clear']);
  });

  it('re-entering the verified address sends nothing', async () => {
    const res = await put(app(), 'u2', 'ANA@example.com');
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(0);
  });

  it('refuses a malformed address, a taken one, mail off and an unknown user', async () => {
    expect((await put(app(), 'u1', 'not-an-address')).status).toBe(400);
    const taken = await put(app(), 'u1', 'Ana@example.com');
    expect(taken.status).toBe(409);
    expect((await taken.json()).code).toBe('EMAIL_TAKEN');
    const off = await put(app({ mail: mailer(false) }), 'u1', 'sam@example.com');
    expect(off.status).toBe(409);
    expect((await off.json()).code).toBe('MAIL_NOT_CONFIGURED');
    expect((await put(app({ mail: null }), 'u1', 'sam@example.com')).status).toBe(409);
    expect((await put(app(), 'nobody', 'x@example.com')).status).toBe(404);
    expect(sent).toHaveLength(0);
  });

  it('is admin-only', async () => {
    const res = await put(app({ role: 'user' }), 'u1', 'sam@example.com');
    expect(res.status).toBe(403);
    expect(sent).toHaveLength(0);
  });
});
