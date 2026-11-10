import { asRole } from '@nicotind/core';
import { signJwt } from '../middleware/auth.js';

/** The signed-in Subsonic caller, as resolved from their API key. */
export interface SubsonicUser {
  id: string;
  username: string;
  role: string;
}

/**
 * Runs one request against NicotinD's own `/api` as `user` (docs/opensubsonic.md).
 *
 * The OpenSubsonic layer is a translator, not a second library: every read and
 * write goes through the same routes, auth middleware, role checks, visibility
 * predicates and streaming code the web app uses, so the two surfaces cannot
 * drift into answering differently.
 */
export type Upstream = (user: SubsonicUser, path: string, init?: RequestInit) => Promise<Response>;

const TOKEN_TTL = '10m';
/** Re-mint well before expiry, so a token is never presented mid-expiry. */
const REUSE_MS = 5 * 60_000;

export function internalUpstream(
  fetchApp: (req: Request) => Response | Promise<Response>,
  jwtSecret: string,
  now: () => number = Date.now,
  /** Test seam: the session signer. */
  sign: typeof signJwt = signJwt,
): Upstream {
  // One short-lived session per user, reused across a library sync's thousands
  // of calls. The key lookup reads the role fresh on every call, so a role
  // change re-mints at once rather than waiting the session out.
  const sessions = new Map<string, { token: string; role: string; until: number }>();

  const session = async (user: SubsonicUser) => {
    let current = sessions.get(user.id);
    if (!current || current.until <= now() || current.role !== user.role) {
      const token = await sign(
        { sub: user.id, username: user.username, role: asRole(user.role) },
        jwtSecret,
        TOKEN_TTL,
      );
      current = { token, role: user.role, until: now() + REUSE_MS };
      sessions.set(user.id, current);
    }
    return current.token;
  };
  const send = async (user: SubsonicUser, path: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${await session(user)}`);
    return fetchApp(new Request(`http://nicotind.internal${path}`, { ...init, headers }));
  };

  return async (user, path, init = {}) => {
    const res = await send(user, path, init);
    // A password change ends every session (`token_version`), including the
    // one cached here — but the Subsonic client authenticated with its API key,
    // which is still good. Re-mint once instead of failing calls for the rest
    // of the cache window.
    if (
      res.status === 401 &&
      (
        await res
          .clone()
          .json()
          .catch(() => null)
      )?.code === 'SESSION_REVOKED'
    ) {
      sessions.delete(user.id);
      return send(user, path, init);
    }
    return res;
  };
}
