/**
 * Increment 5 of docs/email-invitations.md at the HTTP layer: a user adds and
 * verifies their own email, "forgot password" mails a reset link only to a
 * verified address and says the same thing to everyone, an admin can email a
 * reset link, every password write sends a "password changed" notice, and the
 * recovery switch is refused while mail is off.
 */
import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { JwtPayload } from '@nicotind/core';
import { hashPassword, verifyPassword } from '@nicotind/core';
import { applySchema } from '../db.js';

let db: Database = (() => {
  const d = new Database(':memory:');
  applySchema(d);
  return d;
})();
// The auth middleware and the admin routes read the module-level database.
mock.module('../db.js', () => ({ getDatabase: () => db, initDatabase: () => db, applySchema }));

const { authMiddleware, signJwt } = await import('../middleware/auth.js');
type AuthEnv = import('../middleware/auth.js').AuthEnv;
const { accountRoutes } = await import('./account.js');
const { adminRoutes } = await import('./admin.js');
const { mailAdminRoutes } = await import('./mail.js');
const { passwordResetAdminRoutes, passwordResetPublicRoutes } = await import('./password-reset.js');
const { recoveryPublicRoutes, withRecovery, FORGOT_PER_ACCOUNT_MS, FORGOT_RESET_TTL_MS } =
  await import('./recovery.js');
const { authRoutes } = await import('./auth.js');
const { MailService } = await import('../services/mail/mailer.js');
const { MailSettingsStore, readMailEnv } = await import('../services/mail/settings.js');
const { RecoverySetting } = await import('../services/recovery-setting.js');
const { EMAIL_VERIFY_TTL_MS } = await import('../services/email-verification.js');
type MailMessage = import('../services/mail/transport.js').MailMessage;
type MailResult = import('../services/mail/transport.js').MailResult;
type MailServiceT = import('../services/mail/mailer.js').MailService;

const SECRET = 'test-secret';
const HOST = 'http://music.example.com';
let clock: number;
const now = () => clock;
let sent: Array<MailMessage & { kind?: string }>;
let nextResult: MailResult;
let tasks: Promise<void>[];

async function addUser(
  id: string,
  username: string,
  password: string,
  opts: { role?: string; email?: string; verified?: boolean } = {},
) {
  db.run(
    'INSERT INTO users (id, username, password_hash, role, email, email_verified_at) VALUES (?, ?, ?, ?, ?, ?)',
    [
      id,
      username,
      await hashPassword(password),
      opts.role ?? 'user',
      opts.email ?? null,
      opts.email && opts.verified !== false ? 1 : null,
    ],
  );
}

beforeEach(async () => {
  db = new Database(':memory:');
  applySchema(db);
  clock = Date.UTC(2026, 10, 10, 12);
  sent = [];
  nextResult = { ok: true, providerId: 'q-1' };
  tasks = [];
  await addUser('admin1', 'boss', 'bosspass123', { role: 'admin' });
  await addUser('u1', 'sam', 'old-password', { email: 'sam@example.com' });
});

/**
 * Mail with a stub transport; `on: false` is transport `off`. Env-pinned, so an
 * "on" and an "off" service can live side by side on one DB; a custom cap needs
 * the stored settings instead (one service per test then).
 */
function mailer(on = true, cap?: number): MailServiceT {
  const settings = new MailSettingsStore(
    db,
    readMailEnv(cap ? {} : { NICOTIND_MAIL_TRANSPORT: on ? 'smtp' : 'off' }),
  );
  if (cap) {
    settings.update({
      transport: 'smtp',
      host: 'smtp.example.com',
      fromAddress: 'music@example.com',
      dailyCap: cap,
    });
  }
  return new MailService({
    db,
    settings,
    now,
    transportFor: () => ({
      send: async (msg) => {
        sent.push(msg);
        return nextResult;
      },
      verify: async () => ({ ok: true }),
    }),
  });
}

const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const tokenFor = (sub: string, username: string) =>
  signJwt({ sub, username, role: 'user' }, SECRET);

function asAdmin(app: Hono<AuthEnv>) {
  const wrap = new Hono<AuthEnv>();
  wrap.use('*', async (c, next) => {
    c.set('user', { sub: 'admin1', username: 'boss', role: 'admin', iat: 0, exp: 0 } as JwtPayload);
    await next();
  });
  wrap.route('/', app);
  return wrap;
}

/** Account routes behind the real middleware, plus the public verify route. */
function server(
  mail: MailServiceT | null = mailer(),
  recovery?: InstanceType<typeof RecoverySetting>,
) {
  const rec = recovery ?? new RecoverySetting(db, () => mail?.status().enabled ?? false);
  const app = new Hono<AuthEnv>();
  app.route(
    '/api/auth',
    recoveryPublicRoutes({
      db,
      mail: mail ?? mailer(false),
      recovery: rec,
      now,
      serverName: () => 'den',
      background: (t) => void tasks.push(t),
    }),
  );
  app.use('/api/me/*', authMiddleware(SECRET));
  app.route(
    '/api/me/account',
    accountRoutes({
      db,
      jwtSecret: SECRET,
      jwtExpiresIn: '1h',
      mail,
      now,
      serverName: () => 'den',
    }),
  );
  return { app, recovery: rec };
}

async function putEmail(
  app: Hono<AuthEnv>,
  body: Record<string, unknown>,
  sub = 'u1',
  name = 'sam',
) {
  return app.request(`${HOST}/api/me/account/email`, {
    ...json(body, 'PUT'),
    headers: { ...bearer(await tokenFor(sub, name)), 'Content-Type': 'application/json' },
  });
}

const tokenIn = (text: string, path: string) =>
  text.match(new RegExp(`${path}#t=([\\w-]+)`))?.[1] ?? null;

const flush = async () => {
  await Promise.all(tasks);
  await new Promise((r) => setTimeout(r, 5));
};

const auditRows = () =>
  db
    .query<{ action: string; detail: string | null }, []>(
      'SELECT action, detail FROM audit_log ORDER BY id',
    )
    .all();

describe('GET /api/me/account', () => {
  it('reports the address, its state, a pending change and whether mail is on', async () => {
    const { app } = server();
    const res = await app.request('/api/me/account', {
      headers: bearer(await tokenFor('u1', 'sam')),
    });
    expect(await res.json()).toEqual({
      email: 'sam@example.com',
      emailVerified: true,
      pendingEmail: null,
      mailEnabled: true,
    });
    const off = server(mailer(false)).app;
    const res2 = await off.request('/api/me/account', {
      headers: bearer(await tokenFor('u1', 'sam')),
    });
    expect((await res2.json()).mailEnabled).toBe(false);
  });
});

describe('PUT /api/me/account/email + POST /api/auth/verify-email', () => {
  it('needs the current password — a wrong or missing one is 403, never 401', async () => {
    const { app } = server();
    for (const currentPassword of ['wrong', undefined]) {
      const res = await putEmail(app, { email: 'new@example.com', currentPassword });
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('INVALID_CREDENTIALS');
    }
    expect(sent).toHaveLength(0);
  });

  it('validates the address', async () => {
    const res = await putEmail(server().app, { email: 'nope', currentPassword: 'old-password' });
    expect(res.status).toBe(400);
  });

  it('refuses an address another account has, case-insensitively', async () => {
    await addUser('u2', 'ana', 'ana-password', { email: 'ana@example.com' });
    const res = await putEmail(server().app, {
      email: 'ANA@example.com',
      currentPassword: 'old-password',
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('EMAIL_TAKEN');
  });

  it('refuses a change while mail is off', async () => {
    const res = await putEmail(server(mailer(false)).app, {
      email: 'new@example.com',
      currentPassword: 'old-password',
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('MAIL_NOT_CONFIGURED');
  });

  it('mails a link and leaves users.email alone until it is opened', async () => {
    const { app } = server();
    const res = await putEmail(app, {
      email: ' New@Example.com ',
      currentPassword: 'old-password',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      email: 'sam@example.com',
      emailVerified: true,
      pendingEmail: 'new@example.com',
      mail: { ok: true },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('new@example.com');
    const token = tokenIn(sent[0]!.text, `${HOST}/verify-email`);
    expect(token).toBeTruthy();
    // Only the hash is stored.
    const stored = db
      .query<{ token_hash: string }, []>('SELECT token_hash FROM email_verifications')
      .get()!;
    expect(stored.token_hash).not.toContain(token!);

    clock += 1000;
    const verified = await app.request('/api/auth/verify-email', json({ token }));
    expect(verified.status).toBe(200);
    expect(await verified.json()).toEqual({ ok: true, email: 'new@example.com' });
    expect(db.query("SELECT email, email_verified_at FROM users WHERE id = 'u1'").get()).toEqual({
      email: 'new@example.com',
      email_verified_at: clock,
    });
    // Audited without the address.
    expect(JSON.stringify(auditRows())).not.toContain('example.com');
    expect(auditRows().map((r) => r.action)).toEqual(['user.email-change', 'user.email-verified']);
  });

  it('a link works once', async () => {
    const { app } = server();
    await putEmail(app, { email: 'new@example.com', currentPassword: 'old-password' });
    const token = tokenIn(sent[0]!.text, '/verify-email');
    expect((await app.request('/api/auth/verify-email', json({ token }))).status).toBe(200);
    const again = await app.request('/api/auth/verify-email', json({ token }));
    expect(again.status).toBe(410);
    expect((await again.json()).code).toBe('VERIFY_USED');
  });

  it('expires after 24 hours', async () => {
    const { app } = server();
    await putEmail(app, { email: 'new@example.com', currentPassword: 'old-password' });
    const token = tokenIn(sent[0]!.text, '/verify-email');
    clock += EMAIL_VERIFY_TTL_MS;
    const res = await app.request('/api/auth/verify-email', json({ token }));
    expect(res.status).toBe(410);
    expect((await res.json()).code).toBe('VERIFY_EXPIRED');
    expect(db.query("SELECT email FROM users WHERE id = 'u1'").get()).toEqual({
      email: 'sam@example.com',
    });
  });

  it('409s, unspent, when another account took the address meanwhile', async () => {
    const { app } = server();
    await putEmail(app, { email: 'new@example.com', currentPassword: 'old-password' });
    const token = tokenIn(sent[0]!.text, '/verify-email');
    await addUser('u2', 'ana', 'ana-password', { email: 'new@example.com' });
    const res = await app.request('/api/auth/verify-email', json({ token }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('EMAIL_TAKEN');
    expect(
      db.query<{ used_at: number | null }, []>('SELECT used_at FROM email_verifications').get()!
        .used_at,
    ).toBeNull();
  });

  it('a second request replaces the first link', async () => {
    const { app } = server();
    await putEmail(app, { email: 'first@example.com', currentPassword: 'old-password' });
    await putEmail(app, { email: 'second@example.com', currentPassword: 'old-password' });
    const first = tokenIn(sent[0]!.text, '/verify-email');
    expect((await app.request('/api/auth/verify-email', json({ token: first }))).status).toBe(404);
  });

  it('404s an unknown token and rate-limits a stream of them', async () => {
    const { app } = server();
    expect((await app.request('/api/auth/verify-email', json({ token: 'nope' }))).status).toBe(404);
    let last = 0;
    for (let i = 0; i < 10; i++) {
      last = (await app.request('/api/auth/verify-email', json({ token: `t${i}` }))).status;
    }
    expect(last).toBe(429);
  });

  it('an empty address clears the email and any pending change', async () => {
    const { app } = server();
    await putEmail(app, { email: 'new@example.com', currentPassword: 'old-password' });
    const res = await putEmail(app, { email: '', currentPassword: 'old-password' });
    expect(await res.json()).toMatchObject({
      email: null,
      emailVerified: false,
      pendingEmail: null,
    });
    expect(db.query('SELECT id FROM email_verifications WHERE used_at IS NULL').all()).toHaveLength(
      0,
    );
  });

  it('re-entering the verified address sends nothing', async () => {
    const res = await putEmail(server().app, {
      email: 'sam@example.com',
      currentPassword: 'old-password',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty('mail');
    expect(sent).toHaveLength(0);
  });
});

describe('recovery switch (PUT /api/admin/mail/recovery)', () => {
  function mailApp(mail: MailServiceT) {
    const recovery = new RecoverySetting(db, () => mail.status().enabled);
    return {
      recovery,
      app: asAdmin(mailAdminRoutes({ db, mail, recovery, serverName: () => 'den' })),
    };
  }

  it('is off by default, and refused while mail is off', async () => {
    const { app } = mailApp(mailer(false));
    expect((await (await app.request('/')).json()).recovery).toEqual({
      enabled: false,
      effective: false,
    });
    const res = await app.request('/recovery', json({ enabled: true }, 'PUT'));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('MAIL_NOT_CONFIGURED');
  });

  it('turns on with mail on, records the admin origin, and audits', async () => {
    const { app, recovery } = mailApp(mailer());
    const res = await app.request(`${HOST}/recovery`, json({ enabled: true }, 'PUT'));
    expect(res.status).toBe(200);
    expect((await res.json()).recovery).toEqual({ enabled: true, effective: true });
    expect(recovery.stored()).toEqual({ enabled: true, linkBase: HOST });
    expect(auditRows()).toEqual([{ action: 'mail.recovery', detail: 'enabled=true' }]);
    // Off is always allowed.
    expect((await app.request('/recovery', json({ enabled: false }, 'PUT'))).status).toBe(200);
  });

  it('works while the mail block is env-pinned — it is its own setting', async () => {
    const pinned = new MailService({
      db,
      settings: new MailSettingsStore(db, readMailEnv({ NICOTIND_MAIL_TRANSPORT: 'outbox' })),
      now,
    });
    const { app } = mailApp(pinned);
    expect((await app.request('/recovery', json({ enabled: true }, 'PUT'))).status).toBe(200);
  });

  it('reads as off once mail is turned off, without a second switch', async () => {
    let on = true;
    const recovery = new RecoverySetting(db, () => on);
    recovery.set(true, HOST);
    expect(recovery.effective()).toBe(true);
    on = false;
    expect(recovery.effective()).toBe(false);
  });
});

describe('POST /api/auth/forgot', () => {
  async function enabled(mail = mailer()) {
    const s = server(mail);
    s.recovery.set(true, HOST);
    return s;
  }
  const forgot = (app: Hono<AuthEnv>, identifier: unknown, host = HOST) =>
    app.request(`${host}/api/auth/forgot`, json({ identifier }));

  it('status follows the switch and mail', async () => {
    const { app, recovery } = server();
    expect(await (await app.request('/api/auth/recovery-status')).json()).toEqual({
      enabled: false,
    });
    recovery.set(true, HOST);
    expect(await (await app.request('/api/auth/recovery-status')).json()).toEqual({
      enabled: true,
    });
  });

  it('mails a 30-minute reset link to the verified address, by username or email', async () => {
    const { app } = await enabled();
    const res = await forgot(app, 'sam');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('sam@example.com');
    const token = tokenIn(sent[0]!.text, `${HOST}/reset-password`);
    expect(token).toBeTruthy();
    const row = db
      .query<{ created_by: string | null; expires_at: number }, []>(
        'SELECT created_by, expires_at FROM password_resets',
      )
      .get()!;
    expect(row).toEqual({ created_by: null, expires_at: clock + FORGOT_RESET_TTL_MS });

    // The link works on the public reset route.
    const pub = passwordResetPublicRoutes({ db, jwtSecret: SECRET, jwtExpiresIn: '1h', now });
    expect(
      (await pub.request('/complete', json({ token, password: 'brand-new-pass' }))).status,
    ).toBe(200);

    clock += FORGOT_PER_ACCOUNT_MS;
    await forgot(app, 'SAM@example.com');
    await flush();
    expect(sent.map((m) => m.to)).toEqual(['sam@example.com', 'sam@example.com']);
  });

  it('never uses the request Host for the link — an anonymous caller picks it', async () => {
    const { app } = await enabled();
    await forgot(app, 'sam', 'http://evil.example.net');
    await flush();
    expect(sent[0]!.text).toContain(`${HOST}/reset-password#t=`);
    expect(sent[0]!.text).not.toContain('evil');
  });

  it('prefers the operator public URL for the link', async () => {
    const mail = mailer();
    const recovery = new RecoverySetting(db, () => true);
    recovery.set(true, HOST);
    const app = recoveryPublicRoutes({
      db,
      mail,
      recovery,
      now,
      publicUrl: () => 'https://music.example.org',
      background: (t) => void tasks.push(t),
    });
    await app.request('/forgot', json({ identifier: 'sam' }));
    await flush();
    expect(sent[0]!.text).toContain('https://music.example.org/reset-password#t=');
  });

  it('answers identically for every case, and only the eligible one gets mail', async () => {
    await addUser('u2', 'unverified', 'x-password', { email: 'unv@example.com', verified: false });
    await addUser('u3', 'noemail', 'x-password');
    await addUser('u4', 'disabled', 'x-password', { email: 'dis@example.com' });
    db.run("UPDATE users SET status = 'disabled' WHERE id = 'u4'");

    const { app } = await enabled();
    const cases: unknown[] = [
      'nobody',
      'nobody@example.com',
      'unverified',
      'unv@example.com',
      'noemail',
      'disabled',
      '',
      42,
    ];
    const answers: string[] = [];
    for (const identifier of cases) {
      const res = await forgot(app, identifier);
      answers.push(`${res.status} ${await res.text()}`);
    }
    const real = await forgot(app, 'sam');
    answers.push(`${real.status} ${await real.text()}`);
    // Throttled: a second request for the same account inside 15 minutes.
    const throttled = await forgot(app, 'sam');
    answers.push(`${throttled.status} ${await throttled.text()}`);
    await flush();

    expect(new Set(answers)).toEqual(new Set(['200 {"ok":true}']));
    expect(sent.map((m) => m.to)).toEqual(['sam@example.com']);
    expect(db.query('SELECT user_id FROM password_resets').all()).toEqual([{ user_id: 'u1' }]);
  });

  it('says the same and sends nothing while recovery is off', async () => {
    const { app } = server();
    const res = await forgot(app, 'sam');
    expect(`${res.status} ${await res.text()}`).toBe('200 {"ok":true}');
    await flush();
    expect(sent).toHaveLength(0);
    expect(db.query('SELECT id FROM password_resets').all()).toHaveLength(0);
  });

  it('says the same when the quota is exhausted', async () => {
    const mail = mailer(true, 1);
    const { app } = await enabled(mail);
    await mail.send('test', { to: 'x@example.com', subject: 's', text: 't', html: 'h' });
    sent = [];
    const res = await forgot(app, 'sam');
    expect(`${res.status} ${await res.text()}`).toBe('200 {"ok":true}');
    await flush();
    expect(sent).toHaveLength(0);
  });

  it('a reset still goes out when only the reserve is left', async () => {
    const mail = mailer(true, 10);
    const { app } = await enabled(mail);
    for (let i = 0; i < 5; i++) {
      await mail.send('invite', { to: `f${i}@example.com`, subject: 's', text: 't', html: 'h' });
    }
    expect(
      await mail.send('invite', { to: 'f@example.com', subject: 's', text: 't', html: 'h' }),
    ).toMatchObject({ ok: false, reason: 'quota-exhausted' });
    sent = [];
    await forgot(app, 'sam');
    await flush();
    expect(sent.map((m) => m.to)).toEqual(['sam@example.com']);
  });

  it('rate-limits globally, whatever the identifier', async () => {
    const { app } = await enabled();
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await forgot(app, `nobody-${i}`)).status;
    expect(last).toBe(429);
  });
});

describe('admin: Email reset link (send: true)', () => {
  const app = (mail: MailServiceT | null = mailer()) =>
    asAdmin(passwordResetAdminRoutes({ db, now, mail, serverName: () => 'den' }));

  it('mails a 24 h link to the verified address and never returns it', async () => {
    const res = await app().request(`${HOST}/`, json({ userId: 'u1', send: true }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({
      mail: { ok: true, providerId: 'q-1' },
      expiresAt: clock + 24 * 3_600_000,
    });
    expect(JSON.stringify(body)).not.toContain('reset-password');
    expect(sent[0]!.to).toBe('sam@example.com');
    expect(sent[0]!.text).toContain(`${HOST}/reset-password#t=`);
    expect(auditRows()).toEqual([{ action: 'user.reset-link', detail: 'emailed=true' }]);
  });

  it('refuses without a verified address, or with mail off', async () => {
    await addUser('u2', 'ana', 'ana-password', { email: 'ana@example.com', verified: false });
    const unverified = await app().request('/', json({ userId: 'u2', send: true }));
    expect(unverified.status).toBe(409);
    expect((await unverified.json()).code).toBe('NO_VERIFIED_EMAIL');
    const off = await app(mailer(false)).request('/', json({ userId: 'u1', send: true }));
    expect(off.status).toBe(409);
    expect((await off.json()).code).toBe('MAIL_NOT_CONFIGURED');
    expect((await app().request('/', json({ userId: 'ghost', send: true }))).status).toBe(404);
    expect(sent).toHaveLength(0);
  });

  it('without send it still returns the link to copy', async () => {
    const body = await (await app().request('/', json({ userId: 'u1' }))).json();
    expect(body.path).toMatch(/^\/reset-password#t=/);
    expect(sent).toHaveLength(0);
  });
});

describe('"password changed" notice', () => {
  const noticeCount = () => sent.filter((m) => m.subject.includes('was changed')).length;

  it('follows the user’s own change, to the verified address only', async () => {
    const { app } = server();
    const res = await app.request('/api/me/account/password', {
      ...json({ currentPassword: 'old-password', newPassword: 'brand-new-pass' }, 'PUT'),
      headers: { ...bearer(await tokenFor('u1', 'sam')), 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);
    await flush();
    expect(sent.map((m) => m.to)).toEqual(['sam@example.com']);
    expect(sent[0]!.subject).toBe('Your password for den was changed');
    expect(sent[0]!.text).not.toMatch(/https?:\/\//);
  });

  it('follows a reset link and the admin’s Set password…', async () => {
    const mail = mailer();
    const issued = await (
      await asAdmin(passwordResetAdminRoutes({ db, now })).request('/', json({ userId: 'u1' }))
    ).json();
    const pub = passwordResetPublicRoutes({ db, jwtSecret: SECRET, jwtExpiresIn: '1h', now, mail });
    const token = issued.path.split('#t=')[1];
    expect(
      (await pub.request('/complete', json({ token, password: 'brand-new-pass' }))).status,
    ).toBe(200);
    await flush();
    expect(noticeCount()).toBe(1);

    const admin = asAdmin(adminRoutes({ musicDir: '/m', mail, serverName: () => 'den' }));
    const res = await admin.request('/users/u1/password', json({ password: 'admin-set' }, 'PUT'));
    expect(res.status).toBe(200);
    await flush();
    expect(noticeCount()).toBe(2);
    const row = db
      .query<{ password_hash: string }, []>("SELECT password_hash FROM users WHERE id = 'u1'")
      .get()!;
    expect(await verifyPassword('admin-set', row.password_hash)).toBe(true);
  });

  it('is not sent without a verified address or with mail off', async () => {
    await addUser('u2', 'ana', 'ana-password', { email: 'ana@example.com', verified: false });
    const admin = asAdmin(adminRoutes({ musicDir: '/m', mail: mailer(), serverName: () => 'den' }));
    await admin.request('/users/u2/password', json({ password: 'admin-set' }, 'PUT'));
    const offAdmin = asAdmin(adminRoutes({ musicDir: '/m', mail: mailer(false) }));
    await offAdmin.request('/users/u1/password', json({ password: 'admin-set' }, 'PUT'));
    await flush();
    expect(sent).toHaveLength(0);
  });

  it('a failing send never breaks the password change', async () => {
    nextResult = { ok: false, reason: 'unreachable', detail: 'ECONNREFUSED' };
    const { app } = server();
    const res = await app.request('/api/me/account/password', {
      ...json({ currentPassword: 'old-password', newPassword: 'brand-new-pass' }, 'PUT'),
      headers: { ...bearer(await tokenFor('u1', 'sam')), 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);
    await flush();
    expect(sent).toHaveLength(1);
  });
});

describe('withRecovery', () => {
  it('serves the recovery routes inside the auth group without shadowing login', async () => {
    const mail = mailer();
    const recovery = new RecoverySetting(db, () => true);
    recovery.set(true, HOST);
    const app = new Hono<AuthEnv>();
    app.route(
      '/api/auth',
      withRecovery(
        authRoutes(SECRET, '1h', false),
        recoveryPublicRoutes({ db, mail, recovery, now }),
      ),
    );
    expect(await (await app.request('/api/auth/recovery-status')).json()).toEqual({
      enabled: true,
    });
    expect(await (await app.request('/api/auth/registration-status')).json()).toEqual({
      enabled: false,
    });
    const login = await app.request(
      '/api/auth/login',
      json({ username: 'sam', password: 'old-password' }),
    );
    expect(login.status).toBe(200);
  });
});

describe('mail language', () => {
  const saveLanguage = (userId: string, lang: string) =>
    db.run('INSERT INTO user_settings (user_id, language) VALUES (?, ?)', [userId, lang]);

  async function putEmailIn(app: Hono<AuthEnv>, acceptLanguage: string) {
    return app.request(`${HOST}/api/me/account/email`, {
      ...json({ email: 'new@example.com', currentPassword: 'old-password' }, 'PUT'),
      headers: {
        ...bearer(await tokenFor('u1', 'sam')),
        'Content-Type': 'application/json',
        'Accept-Language': acceptLanguage,
      },
    });
  }

  it('words the verify mail in the browser language when the user saved none', async () => {
    const { app } = server();
    expect((await putEmailIn(app, 'es-AR,es;q=0.9,en;q=0.8')).status).toBe(200);
    expect(sent[0]!.subject).toBe('Confirma tu correo para den');
    expect(sent[0]!.html).toContain('<html lang="es">');
  });

  it('a saved language wins over the browser', async () => {
    saveLanguage('u1', 'en');
    const { app } = server();
    await putEmailIn(app, 'es-AR');
    expect(sent[0]!.subject).toBe('Confirm your email for den');
  });

  it('a forgot-password mail follows the account, not the anonymous request', async () => {
    saveLanguage('u1', 'es');
    const { app, recovery } = server();
    recovery.set(true, HOST);
    await app.request(`${HOST}/api/auth/forgot`, {
      ...json({ identifier: 'sam' }),
      headers: { 'Content-Type': 'application/json', 'Accept-Language': 'en-US' },
    });
    await flush();
    expect(sent[0]!.subject).toBe('Restablece tu contraseña de den');
    expect(sent[0]!.text).toContain('vence en 30 minutos');
  });
});
