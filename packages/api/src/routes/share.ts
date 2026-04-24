import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import * as jose from 'jose';
import type { MiddlewareHandler } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import { getDatabase } from '../db.js';

interface ShareTokenRow {
  token: string;
  resource_type: 'playlist' | 'album';
  resource_id: string;
  created_by: string;
  created_at: number;
  first_accessed_at: number | null;
  expires_at: number | null;
}

async function mintShareJwt(creatorId: string, expiresAtMs: number, jwtSecret: string): Promise<string> {
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
    if (body.resourceType !== 'playlist' && body.resourceType !== 'album') {
      return c.json({ error: 'resourceType must be playlist or album' }, 400);
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
      expiresAtMs = row.expires_at!;
    }

    const jwt = await mintShareJwt(row.created_by, expiresAtMs, jwtSecret);

    return c.json({ jwt, resourceType: row.resource_type, resourceId: row.resource_id });
  });

  return app;
}
