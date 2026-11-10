/**
 * Invitation routes (docs/email-invitations.md), split by trust like radio
 * polls: the admin half mounts under `/api/admin/invites` (blanket JWT auth +
 * the admin check here), the public half under `/api/invites`, where the invite
 * token in the body is itself the credential.
 *
 * Public endpoints take the token in a POST body, never a path or query: the
 * link carries it in the URL fragment precisely so it stays out of server and
 * proxy logs, and a GET would put it straight back in.
 */
import { Hono } from 'hono';
import { hostname } from 'node:os';
import type { Database } from 'bun:sqlite';
import type { AuthEnv } from '../middleware/auth.js';
import { signJwt } from '../middleware/auth.js';
import { recordAudit } from '../services/audit-log.js';
import { candidateUrls } from '../services/pairing-urls.js';
import type { RemoteAccess } from '../services/tailscale.js';
import {
  acceptInvite,
  createInvite,
  getInviteSummary,
  inspectInvite,
  listInvites,
  revokeInvite,
  rotateInviteToken,
  type InviteSummary,
} from '../services/invites.js';
import { createFixedWindowLimiter } from './devices.js';

export interface InviteAdminRoutesDeps {
  db: Database;
  /** Funnel URL source for the link's base; null outside a Tailscale setup. */
  remoteAccess?: Pick<RemoteAccess, 'publicUrl'> | null;
  now?: () => number;
}

/**
 * Where the link should point. Same candidates the pairing QR uses (Funnel
 * first, then the request origin, loopback dropped); the web builds the link
 * from the first and warns when the list is empty — a desktop on 127.0.0.1 has
 * no address a friend could open.
 */
async function linkBases(
  remoteAccess: InviteAdminRoutesDeps['remoteAccess'],
  requestUrl: string,
): Promise<string[]> {
  const funnelUrl = remoteAccess ? await remoteAccess.publicUrl().catch(() => null) : null;
  return candidateUrls({ funnelUrl, requestOrigin: new URL(requestUrl).origin });
}

function withLink(invite: InviteSummary, token: string, urls: string[]) {
  return { invite, token, urls, path: `/invite#t=${token}` };
}

export function inviteAdminRoutes(deps: InviteAdminRoutesDeps) {
  const { db, remoteAccess = null } = deps;
  const now = deps.now ?? Date.now;
  const app = new Hono<AuthEnv>();

  app.use('*', async (c, next) => {
    if (c.get('user')?.role !== 'admin') {
      return c.json({ error: 'Admin access required', code: 'FORBIDDEN' }, 403);
    }
    await next();
  });

  app.get('/', (c) => c.json({ invites: listInvites(db, now()) }));

  app.post('/', async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    const actor = c.get('user');
    const result = createInvite(db, actor.sub, body, now());
    if (!result.ok) return c.json({ error: result.error, code: result.code }, 400);
    recordAudit(db, actor, 'invite.create', {
      targetKind: 'invite',
      targetId: result.invite.id,
      detail: `role=${result.invite.role} uses=${result.invite.maxUses}`,
    });
    const urls = await linkBases(remoteAccess, c.req.url);
    return c.json(withLink(result.invite, result.token, urls), 201);
  });

  app.post('/:id/link', async (c) => {
    const id = c.req.param('id');
    const result = rotateInviteToken(db, id, now());
    if (!result.ok) {
      return result.code === 'NOT_FOUND'
        ? c.json({ error: 'Invite not found', code: 'NOT_FOUND' }, 404)
        : c.json({ error: 'Invite is no longer pending', code: result.code }, 409);
    }
    recordAudit(db, c.get('user'), 'invite.rotate', { targetKind: 'invite', targetId: id });
    const urls = await linkBases(remoteAccess, c.req.url);
    return c.json(withLink(result.invite, result.token, urls));
  });

  app.delete('/:id', (c) => {
    const id = c.req.param('id');
    if (!getInviteSummary(db, id, now())) {
      return c.json({ error: 'Invite not found', code: 'NOT_FOUND' }, 404);
    }
    const invite = revokeInvite(db, id, now());
    recordAudit(db, c.get('user'), 'invite.revoke', { targetKind: 'invite', targetId: id });
    return c.json({ invite });
  });

  return app;
}

export interface InvitePublicRoutesDeps {
  db: Database;
  jwtSecret: string;
  jwtExpiresIn: string;
  now?: () => number;
}

export function invitePublicRoutes(deps: InvitePublicRoutesDeps) {
  const { db, jwtSecret, jwtExpiresIn } = deps;
  const now = deps.now ?? Date.now;
  const app = new Hono<AuthEnv>();

  // Same posture as the pairing claim: a global attempts budget plus a stricter
  // budget for unknown tokens. 256-bit tokens are not guessable; the limiter is
  // about keeping an anonymous endpoint cheap, not about entropy.
  const attemptLimiter = createFixedWindowLimiter(30, 60_000, now);
  const failureLimiter = createFixedWindowLimiter(10, 5 * 60_000, now);
  const rateLimited = { error: 'Too many attempts, try again later', code: 'RATE_LIMITED' };

  app.post('/inspect', async (c) => {
    if (!attemptLimiter.hit()) return c.json(rateLimited, 429);
    const body = await c.req.json<{ token?: unknown }>().catch(() => ({}) as { token?: unknown });
    const token = typeof body.token === 'string' ? body.token : '';
    const result = inspectInvite(db, token, now());
    if (result.status === 'invalid' && !failureLimiter.hit()) return c.json(rateLimited, 429);
    return c.json({ ...result, serverName: hostname() });
  });

  app.post('/accept', async (c) => {
    if (!attemptLimiter.hit()) return c.json(rateLimited, 429);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    const result = await acceptInvite(db, body, now());
    if (!result.ok) {
      if (result.code === 'INVITE_INVALID' && !failureLimiter.hit()) {
        return c.json(rateLimited, 429);
      }
      const status =
        result.code === 'VALIDATION_ERROR'
          ? 400
          : result.code === 'USERNAME_TAKEN'
            ? 409
            : result.code === 'INVITE_INVALID'
              ? 404
              : 410;
      return c.json({ error: result.error, code: result.code }, status);
    }
    const { user } = result;
    recordAudit(db, { sub: user.id, username: user.username }, 'invite.accept', {
      targetKind: 'invite',
      targetId: result.inviteId,
      detail: `role=${user.role}`,
    });
    const token = await signJwt(
      { sub: user.id, username: user.username, role: user.role },
      jwtSecret,
      jwtExpiresIn,
    );
    return c.json({ token, user }, 201);
  });

  return app;
}
