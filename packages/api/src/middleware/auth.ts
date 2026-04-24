import { createMiddleware } from 'hono/factory';
import * as jose from 'jose';
import type { JwtPayload } from '@nicotind/core';
import { getDatabase } from '../db.js';

export type AuthEnv = {
  Variables: {
    user: JwtPayload;
  };
};

export function authMiddleware(jwtSecret: string) {
  const secret = new TextEncoder().encode(jwtSecret);

  return createMiddleware<AuthEnv>(async (c, next) => {
    const authHeader = c.req.header('Authorization');
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : c.req.query('token');

    if (!token) {
      return c.json({ error: 'Missing or invalid Authorization header' }, 401);
    }

    try {
      const { payload } = await jose.jwtVerify(token, secret);
      const jwtPayload = payload as unknown as JwtPayload;

      // Check if user account is disabled
      const db = getDatabase();
      const user = db
        .query<{ status: string }, [string]>(
          "SELECT COALESCE(status, 'active') as status FROM users WHERE id = ?",
        )
        .get(jwtPayload.sub);

      if (!user || user.status === 'disabled') {
        return c.json({ error: 'Account disabled' }, 403);
      }

      c.set('user', jwtPayload);
      if (jwtPayload.share === true && c.req.method !== 'GET') {
        return c.json({ error: 'Share sessions are read-only' }, 403);
      }
      await next();
    } catch {
      return c.json({ error: 'Invalid or expired token' }, 401);
    }
  });
}

export async function signJwt(
  payload: Omit<JwtPayload, 'iat' | 'exp'>,
  secret: string,
  expiresIn = '24h',
): Promise<string> {
  const secretKey = new TextEncoder().encode(secret);
  return new jose.SignJWT(payload as unknown as jose.JWTPayload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secretKey);
}
