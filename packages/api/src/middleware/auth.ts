import { createMiddleware } from 'hono/factory';
import * as jose from 'jose';
import type { JwtPayload } from '@nicotind/core';
import { getDatabase } from '../db.js';
import { isMediaKey, MEDIA_PATH_RE, verifyMediaKey } from '../services/media-key.js';
import { sessionVersionMatches, sessionVersionOf } from '../services/session-version.js';

export type AuthEnv = {
  Variables: {
    user: JwtPayload;
  };
};

export function authMiddleware(jwtSecret: string) {
  const secret = new TextEncoder().encode(jwtSecret);

  return createMiddleware<AuthEnv>(async (c, next) => {
    const authHeader = c.req.header('Authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : c.req.query('token');

    if (!token) {
      return c.json({ error: 'Missing or invalid Authorization header' }, 401);
    }

    // A media key (#1329) stands in for the JWT in media URLs only: from the
    // query string, on a GET, for covers, streams and waveforms.
    if (!authHeader && isMediaKey(token)) {
      if (c.req.method !== 'GET' || !MEDIA_PATH_RE.test(c.req.path)) {
        return c.json({ error: 'Media key not valid here' }, 401);
      }
      const mediaUser = verifyMediaKey(getDatabase(), jwtSecret, token);
      if (!mediaUser) return c.json({ error: 'Invalid or expired media key' }, 401);
      c.set('user', { ...mediaUser, iat: 0, exp: 0 } as JwtPayload);
      await next();
      return;
    }

    // Only a token that does not verify is an auth failure. The account lookup
    // below is deliberately outside this catch: a database error is not an
    // expired session, and reporting it as 401 signed the user out with a
    // message that was false and never reached `errorHandler` (issue #927).
    let jwtPayload: JwtPayload;
    try {
      const { payload } = await jose.jwtVerify(token, secret);
      jwtPayload = payload as unknown as JwtPayload;
    } catch {
      return c.json({ error: 'Invalid or expired token' }, 401);
    }

    // Check if user account is disabled. A throw here propagates to the app's
    // error handler as a 5xx, which is what a storage failure is.
    const db = getDatabase();
    const user = db
      .query<{ status: string; token_version: number }, [string]>(
        "SELECT COALESCE(status, 'active') as status, COALESCE(token_version, 0) as token_version FROM users WHERE id = ?",
      )
      .get(jwtPayload.sub);

    if (!user || user.status === 'disabled') {
      return c.json({ error: 'Account disabled' }, 403);
    }

    // A password change/reset bumped the version: every older session is over.
    // 401 (not 403) so clients do exactly what they do for an expired token.
    if (!sessionVersionMatches(jwtPayload, user.token_version)) {
      return c.json({ error: 'Session ended — sign in again', code: 'SESSION_REVOKED' }, 401);
    }

    c.set('user', jwtPayload);
    if (jwtPayload.share === true && c.req.method !== 'GET') {
      return c.json({ error: 'Share sessions are read-only' }, 403);
    }
    await next();
  });
}

/**
 * The session version a new token is minted at. Read here rather than at each
 * of the mint sites (login, register, setup, refresh, pairing, invites, the
 * OpenSubsonic upstream) so none of them can forget it — a forgotten `tv` would
 * mint a token that dies the moment the user's version is first bumped.
 *
 * No database means a unit test that exercises signing alone; there is no
 * session state to read, and version 0 is what such a user would have.
 */
function mintVersion(userId: string): number {
  let db;
  try {
    db = getDatabase();
  } catch {
    return 0;
  }
  return sessionVersionOf(db, userId);
}

export async function signJwt(
  payload: Omit<JwtPayload, 'iat' | 'exp'>,
  secret: string,
  expiresIn = '24h',
): Promise<string> {
  const secretKey = new TextEncoder().encode(secret);
  const claims = { ...payload, tv: payload.tv ?? mintVersion(payload.sub) };
  return new jose.SignJWT(claims as unknown as jose.JWTPayload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secretKey);
}
