/**
 * Increment 2 of docs/email-invitations.md at the HTTP layer: admin-issued
 * reset links, the public landing that spends them, the signed-in user's own
 * password change, and the session-version bump every one of them performs.
 */
import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import * as jose from 'jose';
import type { JwtPayload } from '@nicotind/core';
import { hashPassword, verifyPassword } from '@nicotind/core';
import { applySchema } from '../db.js';

let db: Database = (() => {
  const d = new Database(':memory:');
  applySchema(d);
  return d;
})();
// The auth middleware and signJwt read the module-level database.
mock.module('../db.js', () => ({ getDatabase: () => db, initDatabase: () => db, applySchema }));

const { authMiddleware, signJwt } = await import('../middleware/auth.js');
type AuthEnv = import('../middleware/auth.js').AuthEnv;
const { passwordResetAdminRoutes, passwordResetPublicRoutes } = await import('./password-reset.js');
const { accountRoutes } = await import('./account.js');
const { adminRoutes } = await import('./admin.js');
const { ADMIN_RESET_TTL_MS } = await import('../services/password-reset.js');

const SECRET = 'test-secret';
let clock = 1_700_000_000_000;
const now = () => clock;

async function addUser(id: string, username: string, password: string, role = 'user') {
  db.run('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)', [
    id,
    username,
    await hashPassword(password),
    role,
  ]);
}

beforeEach(async () => {
  db = new Database(':memory:');
  applySchema(db);
  clock = 1_700_000_000_000;
  await addUser('admin1', 'boss', 'bosspass123', 'admin');
  await addUser('u1', 'sam', 'old-password');
});

const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function asAdmin<T extends Hono<AuthEnv>>(app: T, role: 'admin' | 'user' = 'admin') {
  const wrap = new Hono<AuthEnv>();
  wrap.use('*', async (c, next) => {
    c.set('user', { sub: 'admin1', username: 'boss', role, iat: 0, exp: 0 } as JwtPayload);
    await next();
  });
  wrap.route('/', app);
  return wrap;
}

const adminApp = (role: 'admin' | 'user' = 'admin') =>
  asAdmin(
    passwordResetAdminRoutes({ db, now, remoteAccess: { publicUrl: async () => null } }),
    role,
  );
const pub = () => passwordResetPublicRoutes({ db, jwtSecret: SECRET, jwtExpiresIn: '1h', now });

/** The real middleware in front of the account routes and a probe. */
function signedIn() {
  const app = new Hono<AuthEnv>();
  app.use('*', authMiddleware(SECRET));
  app.route('/me/account', accountRoutes({ db, jwtSecret: SECRET, jwtExpiresIn: '1h' }));
  app.get('/probe', (c) => c.json({ ok: true }));
  return app;
}
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const samToken = () => signJwt({ sub: 'u1', username: 'sam', role: 'user' }, SECRET);

async function issue(userId = 'u1') {
  const res = await adminApp().request('http://music.example.com/', json({ userId }));
  expect(res.status).toBe(201);
  const body = (await res.json()) as { path: string; urls: string[]; expiresAt: number };
  return { ...body, token: body.path.split('#t=')[1] };
}

const audit = () =>
  db
    .query<{ action: string }, []>('SELECT action FROM audit_log ORDER BY id')
    .all()
    .map((r) => r.action);

describe('admin: issue a reset link', () => {
  it('rejects non-admins', async () => {
    expect((await adminApp('user').request('/', json({ userId: 'u1' }))).status).toBe(403);
  });

  it('issues a 24h single-use link, stores only the hash, and audits', async () => {
    const { token, path, urls, expiresAt } = await issue();
    expect(path).toBe(`/reset-password#t=${token}`);
    expect(urls).toEqual(['http://music.example.com']);
    expect(expiresAt).toBe(clock + ADMIN_RESET_TTL_MS);
    const stored = db
      .query<{ token_hash: string }, []>('SELECT token_hash FROM password_resets')
      .get()!;
    expect(stored.token_hash).not.toContain(token);
    expect(audit()).toEqual(['user.reset-link']);
  });

  it('a re-issue kills the previous link', async () => {
    const first = await issue();
    await issue();
    const res = await pub().request('/inspect', json({ token: first.token }));
    expect((await res.json()).status).toBe('invalid');
  });

  it('validates the user', async () => {
    expect((await adminApp().request('/', json({}))).status).toBe(400);
    expect((await adminApp().request('/', json({ userId: 'ghost' }))).status).toBe(404);
  });
});

describe('public: spend a reset link', () => {
  it('inspects as valid and names the account', async () => {
    const { token } = await issue();
    expect(await (await pub().request('/inspect', json({ token }))).json()).toEqual({
      status: 'valid',
      username: 'sam',
    });
  });

  it('sets the password, ends old sessions, and signs this one in', async () => {
    const before = await samToken();
    const { token } = await issue();
    const res = await pub().request('/complete', json({ token, password: 'brand-new-pass' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user).toMatchObject({ id: 'u1', username: 'sam' });
    const row = db
      .query<{ password_hash: string }, []>("SELECT password_hash FROM users WHERE id = 'u1'")
      .get()!;
    expect(await verifyPassword('brand-new-pass', row.password_hash)).toBe(true);

    const app = signedIn();
    const old = await app.request('/probe', { headers: bearer(before) });
    expect(old.status).toBe(401);
    expect((await old.json()).code).toBe('SESSION_REVOKED');
    expect((await app.request('/probe', { headers: bearer(body.token) })).status).toBe(200);
    expect(jose.decodeJwt(body.token).tv).toBe(1);
    expect(audit()).toEqual(['user.reset-link', 'user.password-reset-link-used']);
  });

  it('works once', async () => {
    const { token } = await issue();
    await pub().request('/complete', json({ token, password: 'brand-new-pass' }));
    const again = await pub().request('/complete', json({ token, password: 'another-pass' }));
    expect(again.status).toBe(410);
    expect((await again.json()).code).toBe('RESET_USED');
    expect((await (await pub().request('/inspect', json({ token }))).json()).status).toBe('used');
  });

  it('expires', async () => {
    const { token } = await issue();
    clock += ADMIN_RESET_TTL_MS;
    const res = await pub().request('/complete', json({ token, password: 'brand-new-pass' }));
    expect((await res.json()).code).toBe('RESET_EXPIRED');
  });

  it('rejects a short password without spending the link', async () => {
    const { token } = await issue();
    const res = await pub().request('/complete', json({ token, password: 'short' }));
    expect(res.status).toBe(400);
    expect((await (await pub().request('/inspect', json({ token }))).json()).status).toBe('valid');
  });

  it('refuses a disabled account', async () => {
    const { token } = await issue();
    db.run("UPDATE users SET status = 'disabled' WHERE id = 'u1'");
    const res = await pub().request('/complete', json({ token, password: 'brand-new-pass' }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('ACCOUNT_DISABLED');
  });

  it('404s an unknown token and rate-limits a stream of them', async () => {
    const app = pub();
    const first = await app.request(
      '/complete',
      json({ token: 'nope', password: 'brand-new-pass' }),
    );
    expect(first.status).toBe(404);
    let last = 0;
    for (let i = 0; i < 10; i++)
      last = (await app.request('/inspect', json({ token: `t${i}` }))).status;
    expect(last).toBe(429);
  });
});

describe('PUT /me/account/password', () => {
  it('needs the current password', async () => {
    const res = await signedIn().request('/me/account/password', {
      ...json({ currentPassword: 'wrong', newPassword: 'brand-new-pass' }, 'PUT'),
      headers: { ...bearer(await samToken()), 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('INVALID_CREDENTIALS');
  });

  it('enforces the minimum length', async () => {
    const res = await signedIn().request('/me/account/password', {
      ...json({ currentPassword: 'old-password', newPassword: 'short' }, 'PUT'),
      headers: { ...bearer(await samToken()), 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });

  it('changes it, keeps this device signed in, ends every other session', async () => {
    const here = await samToken();
    const elsewhere = await samToken();
    const app = signedIn();
    const res = await app.request('/me/account/password', {
      ...json({ currentPassword: 'old-password', newPassword: 'brand-new-pass' }, 'PUT'),
      headers: { ...bearer(here), 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);
    const { token } = await res.json();
    expect((await app.request('/probe', { headers: bearer(token) })).status).toBe(200);
    expect((await app.request('/probe', { headers: bearer(elsewhere) })).status).toBe(401);
    expect((await app.request('/probe', { headers: bearer(here) })).status).toBe(401);
    expect(audit()).toEqual(['user.password-change']);
  });

  it('keeps a paired device bound to its device row', async () => {
    const paired = await signJwt(
      { sub: 'u1', username: 'sam', role: 'user', deviceId: 'd1' },
      SECRET,
    );
    const res = await signedIn().request('/me/account/password', {
      ...json({ currentPassword: 'old-password', newPassword: 'brand-new-pass' }, 'PUT'),
      headers: { ...bearer(paired), 'Content-Type': 'application/json' },
    });
    expect(jose.decodeJwt((await res.json()).token).deviceId).toBe('d1');
  });
});

describe('admin "set password" also ends sessions', () => {
  it('bumps the session version', async () => {
    const before = await samToken();
    const app = asAdmin(adminRoutes({ musicDir: '/m' }));
    const res = await app.request('/users/u1/password', json({ password: 'admin-chosen' }, 'PUT'));
    expect(res.status).toBe(200);
    expect((await signedIn().request('/probe', { headers: bearer(before) })).status).toBe(401);
  });
});
