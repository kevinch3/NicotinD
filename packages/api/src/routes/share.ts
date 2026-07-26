import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import * as jose from 'jose';
import type { MiddlewareHandler } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import { getDatabase } from '../db.js';

export type ShareResourceType = 'playlist' | 'album' | 'artist';

interface ShareTokenRow {
  token: string;
  resource_type: ShareResourceType;
  resource_id: string;
  created_by: string;
  created_at: number;
  first_accessed_at: number | null;
  expires_at: number | null;
}

const SHAREABLE_TYPES: ReadonlySet<string> = new Set(['playlist', 'album', 'artist']);

export async function mintShareJwt(
  creatorId: string,
  expiresAtMs: number,
  jwtSecret: string,
): Promise<string> {
  const secretKey = new TextEncoder().encode(jwtSecret);
  return new jose.SignJWT({ share: true, scope: 'read' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(creatorId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAtMs / 1000))
    .sign(secretKey);
}

export function shareRoutes(jwtSecret: string, auth: MiddlewareHandler) {
  const app = new Hono<AuthEnv>();

  // POST /api/share — generate share link (auth required)
  app.post('/', auth, async (c) => {
    const body = await c.req.json<{ resourceType?: string; resourceId?: string }>();

    if (!body.resourceType || !body.resourceId) {
      return c.json({ error: 'resourceType and resourceId are required' }, 400);
    }
    if (!SHAREABLE_TYPES.has(body.resourceType)) {
      return c.json({ error: 'resourceType must be playlist, album or artist' }, 400);
    }

    const user = c.get('user');
    const token = randomBytes(16).toString('base64url');
    const now = Date.now();

    getDatabase().run(
      'INSERT INTO share_tokens (token, resource_type, resource_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
      [token, body.resourceType, body.resourceId, user.sub, now],
    );

    const origin = new URL(c.req.url).origin;
    return c.json({ url: `${origin}/share/${token}` });
  });

  // POST /api/share/activate/:token — public, no auth
  app.post('/activate/:token', async (c) => {
    const db = getDatabase();
    const row = db
      .query<ShareTokenRow, [string]>('SELECT * FROM share_tokens WHERE token = ?')
      .get(c.req.param('token'));

    if (!row) return c.json({ error: 'Not found' }, 404);

    const now = Date.now();

    if (row.expires_at !== null && row.expires_at < now) {
      return c.json({ error: 'Share link has expired' }, 410);
    }

    let expiresAtMs: number;

    if (row.first_accessed_at === null) {
      expiresAtMs = now + 300_000;
      db.run('UPDATE share_tokens SET first_accessed_at = ?, expires_at = ? WHERE token = ?', [
        now,
        expiresAtMs,
        row.token,
      ]);
    } else {
      expiresAtMs = row.expires_at ?? row.first_accessed_at + 300_000;
    }

    const jwt = await mintShareJwt(row.created_by, expiresAtMs, jwtSecret);

    return c.json({ jwt, resourceType: row.resource_type, resourceId: row.resource_id });
  });

  // GET /api/share/:token/resource — auth-gated, side-effect free (issue #230).
  // An already-logged-in user opening a share link should land on the real
  // in-app page under their *own* full session, not burn the one-time public
  // token and get the restricted 5-minute guest view. The web client checks its
  // own auth first and, when logged in, calls this to map token → resource
  // without ever calling `activate` (so `first_accessed_at`/the public clock is
  // never touched) and redirects into the app. Auth-gating it means only a real
  // session can resolve-without-activating — an anonymous visitor still goes
  // through the public `activate` path. Access here is governed by the caller's
  // own session, not the share's 5-minute window, so an expired public window
  // does not block a logged-in user from opening the resource they can already
  // see; an unknown token still 404s.
  app.get('/:token/resource', auth, (c) => {
    const row = getDatabase()
      .query<
        Pick<ShareTokenRow, 'resource_type' | 'resource_id'>,
        [string]
      >('SELECT resource_type, resource_id FROM share_tokens WHERE token = ?')
      .get(c.req.param('token'));

    if (!row) return c.json({ error: 'Not found' }, 404);

    return c.json({ resourceType: row.resource_type, resourceId: row.resource_id });
  });

  return app;
}
