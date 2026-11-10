/**
 * Invitations end to end at the HTTP layer (docs/email-invitations.md): the
 * admin half mints, lists, rotates and revokes; the public half inspects and
 * accepts with the token as the only credential.
 */
import { describe, expect, it, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import * as jose from 'jose';
import type { JwtPayload } from '@nicotind/core';
import { verifyPassword } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { applySchema } from '../db.js';
import { inviteAdminRoutes, invitePublicRoutes } from './invites.js';
import { hashInviteToken, inviteStatus, MAX_INVITE_USES } from '../services/invites.js';

const SECRET = 'test-secret';
const HOUR = 3_600_000;

let db: Database;
let clock: number;
const now = () => clock;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  db.run(
    "INSERT INTO users (id, username, password_hash, role) VALUES ('admin1', 'boss', 'x', 'admin')",
  );
  clock = 1_700_000_000_000;
});

function admin(role: 'admin' | 'user' = 'admin', remoteUrl: string | null = null) {
  const wrap = new Hono<AuthEnv>();
  wrap.use('*', async (c, next) => {
    c.set('user', { sub: 'admin1', username: 'boss', role, iat: 0, exp: 0 } as JwtPayload);
    await next();
  });
  wrap.route(
    '/',
    inviteAdminRoutes({ db, now, remoteAccess: { publicUrl: async () => remoteUrl } }),
  );
  return wrap;
}

function pub() {
  return invitePublicRoutes({ db, jwtSecret: SECRET, jwtExpiresIn: '1h', now });
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function mint(body: Record<string, unknown> = {}) {
  const res = await admin().request('http://music.example.com/', json(body));
  expect(res.status).toBe(201);
  return (await res.json()) as {
    token: string;
    path: string;
    urls: string[];
    invite: { id: string; role: string; status: string; maxUses: number; expiresAt: number };
  };
}

function auditActions(): string[] {
  return db
    .query<{ action: string }, []>('SELECT action FROM audit_log ORDER BY id')
    .all()
    .map((r) => r.action);
}

describe('inviteStatus', () => {
  const base = { revoked_at: null, use_count: 0, max_uses: 1, expires_at: 100 };
  it('is pending while unused and unexpired', () => {
    expect(inviteStatus(base, 50)).toBe('pending');
  });
  it('expires at the instant, not one tick after', () => {
    expect(inviteStatus(base, 100)).toBe('expired');
  });
  it('reports used before expired — what happened beats what lapsed', () => {
    expect(inviteStatus({ ...base, use_count: 1 }, 200)).toBe('used');
  });
  it('reports revoked over everything', () => {
    expect(inviteStatus({ ...base, revoked_at: 10, use_count: 1 }, 200)).toBe('revoked');
  });
});

describe('admin: create', () => {
  it('rejects non-admins', async () => {
    const res = await admin('user').request('/', json({}));
    expect(res.status).toBe(403);
  });

  it('mints a single-use, 7-day user invite by default and stores only the hash', async () => {
    const { token, invite, path } = await mint();
    expect(invite).toMatchObject({ role: 'user', status: 'pending', maxUses: 1 });
    expect(invite.expiresAt).toBe(clock + 168 * HOUR);
    expect(path).toBe(`/invite#t=${token}`);
    const row = db.query<{ token_hash: string }, []>('SELECT token_hash FROM invites').get()!;
    expect(row.token_hash).toBe(hashInviteToken(token));
    expect(row.token_hash).not.toContain(token);
    expect(auditActions()).toEqual(['invite.create']);
  });

  it('builds link bases from the Funnel URL and the request origin, never loopback', async () => {
    const res = await admin('admin', 'https://box.tail.ts.net').request(
      'http://127.0.0.1:8484/',
      json({}),
    );
    expect((await res.json()).urls).toEqual(['https://box.tail.ts.net']);
    const lan = await mint();
    expect(lan.urls).toEqual(['http://music.example.com']);
  });

  it.each([
    [{ role: 'owner' }],
    [{ expiresInHours: 5 }],
    [{ maxUses: 0 }],
    [{ maxUses: MAX_INVITE_USES + 1 }],
    [{ maxUses: 1.5 }],
    [{ note: 42 }],
  ])('rejects invalid input %j', async (body) => {
    const res = await admin().request('/', json(body));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_ERROR');
  });
});

describe('admin: list, rotate, revoke', () => {
  it('lists pending first, and hides finished invites after a week', async () => {
    const old = await mint({ expiresInHours: 24 });
    clock += 2 * HOUR;
    const fresh = await mint();
    clock += 23 * HOUR; // `old` expired one hour ago
    let list = (await (await admin().request('/')).json()).invites as Array<{
      id: string;
      status: string;
    }>;
    expect(list.map((i) => [i.id, i.status])).toEqual([
      [fresh.invite.id, 'pending'],
      [old.invite.id, 'expired'],
    ]);
    clock += 7 * 24 * HOUR;
    list = (await (await admin().request('/')).json()).invites;
    expect(list.map((i) => i.id)).not.toContain(old.invite.id);
  });

  it('rotating a link kills the old token', async () => {
    const first = await mint();
    const res = await admin().request(`http://music.example.com/${first.invite.id}/link`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const second = await res.json();
    expect(second.token).not.toBe(first.token);
    expect(
      (await (await pub().request('/inspect', json({ token: first.token }))).json()).status,
    ).toBe('invalid');
    expect(
      (await (await pub().request('/inspect', json({ token: second.token }))).json()).status,
    ).toBe('pending');
  });

  it('refuses to rotate a finished invite', async () => {
    const { invite } = await mint();
    await admin().request(`/${invite.id}`, { method: 'DELETE' });
    const res = await admin().request(`/${invite.id}/link`, { method: 'POST' });
    expect(res.status).toBe(409);
  });

  it('revokes, idempotently, and audits', async () => {
    const { invite, token } = await mint();
    const res = await admin().request(`/${invite.id}`, { method: 'DELETE' });
    expect((await res.json()).invite.status).toBe('revoked');
    clock += 1000;
    await admin().request(`/${invite.id}`, { method: 'DELETE' });
    const row = db.query<{ revoked_at: number }, []>('SELECT revoked_at FROM invites').get()!;
    expect(row.revoked_at).toBe(clock - 1000);
    expect((await (await pub().request('/inspect', json({ token }))).json()).status).toBe(
      'revoked',
    );
    expect(auditActions()).toEqual(['invite.create', 'invite.revoke', 'invite.revoke']);
  });

  it('404s an unknown invite', async () => {
    expect((await admin().request('/nope', { method: 'DELETE' })).status).toBe(404);
    expect((await admin().request('/nope/link', { method: 'POST' })).status).toBe(404);
  });
});

describe('public: inspect', () => {
  it('reveals role and inviter only for a pending invite', async () => {
    const { token } = await mint({ role: 'listener' });
    const body = await (await pub().request('/inspect', json({ token }))).json();
    expect(body).toMatchObject({ status: 'pending', role: 'listener', invitedBy: 'boss' });
    expect(typeof body.serverName).toBe('string');
  });

  it('says invalid for an unknown or missing token', async () => {
    expect((await (await pub().request('/inspect', json({ token: 'x' }))).json()).status).toBe(
      'invalid',
    );
    expect((await (await pub().request('/inspect', json({}))).json()).status).toBe('invalid');
  });

  it('rate-limits a stream of unknown tokens', async () => {
    const app = pub();
    let last = 0;
    for (let i = 0; i < 11; i++)
      last = (await app.request('/inspect', json({ token: `t${i}` }))).status;
    expect(last).toBe(429);
  });
});

describe('public: accept', () => {
  const accept = (body: Record<string, unknown>, app = pub()) => app.request('/accept', json(body));

  it('creates the account at the invite role and signs it in', async () => {
    const { token, invite } = await mint({ role: 'refiner' });
    const res = await accept({ token, username: 'friend', password: 'longenough' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user).toMatchObject({ username: 'friend', role: 'refiner' });
    const claims = jose.decodeJwt(body.token);
    expect(claims).toMatchObject({ sub: body.user.id, role: 'refiner' });
    const user = db
      .query<{ password_hash: string }, [string]>('SELECT password_hash FROM users WHERE id = ?')
      .get(body.user.id)!;
    expect(await verifyPassword('longenough', user.password_hash)).toBe(true);
    expect(
      db.query('SELECT user_id FROM user_settings WHERE user_id = ?').get(body.user.id),
    ).toBeTruthy();
    const list = (await (await admin().request('/')).json()).invites;
    expect(list[0]).toMatchObject({ id: invite.id, status: 'used', acceptedBy: ['friend'] });
    expect(auditActions()).toEqual(['invite.create', 'invite.accept']);
  });

  it('spends a single-use invite exactly once', async () => {
    const { token } = await mint();
    expect((await accept({ token, username: 'a', password: 'longenough' })).status).toBe(201);
    const res = await accept({ token, username: 'b', password: 'longenough' });
    expect(res.status).toBe(410);
    expect((await res.json()).code).toBe('INVITE_USED');
  });

  it('lets a multi-use invite run out at its cap', async () => {
    const { token } = await mint({ maxUses: 2 });
    expect((await accept({ token, username: 'a', password: 'longenough' })).status).toBe(201);
    expect((await accept({ token, username: 'b', password: 'longenough' })).status).toBe(201);
    expect((await accept({ token, username: 'c', password: 'longenough' })).status).toBe(410);
  });

  it('refuses an expired invite', async () => {
    const { token } = await mint({ expiresInHours: 24 });
    clock += 24 * HOUR;
    const res = await accept({ token, username: 'late', password: 'longenough' });
    expect(res.status).toBe(410);
    expect((await res.json()).code).toBe('INVITE_EXPIRED');
  });

  it('refuses a revoked invite', async () => {
    const { token, invite } = await mint();
    await admin().request(`/${invite.id}`, { method: 'DELETE' });
    const res = await accept({ token, username: 'x', password: 'longenough' });
    expect((await res.json()).code).toBe('INVITE_REVOKED');
  });

  it('404s an unknown token', async () => {
    const res = await accept({ token: 'nope', username: 'x', password: 'longenough' });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('INVITE_INVALID');
  });

  it('keeps the invite unspent when the username is taken', async () => {
    const { token } = await mint();
    const res = await accept({ token, username: 'boss', password: 'longenough' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('USERNAME_TAKEN');
    expect((await accept({ token, username: 'other', password: 'longenough' })).status).toBe(201);
  });

  it.each([
    [{ username: '', password: 'longenough' }],
    [{ username: 'has space', password: 'longenough' }],
    [{ username: 'x'.repeat(65), password: 'longenough' }],
    [{ username: 'ok', password: 'short' }],
  ])('validates %j without spending the invite', async (fields) => {
    const { token } = await mint();
    const res = await accept({ token, ...fields });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_ERROR');
    expect(
      db.query<{ use_count: number }, []>('SELECT use_count FROM invites').get()!.use_count,
    ).toBe(0);
  });
});
