import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Database } from 'bun:sqlite';

/**
 * A per-user key for media URLs (`/api/cover`, `/api/stream`, `/api/peaks`),
 * used in `?token=` instead of the session JWT (#1329).
 *
 * The JWT rotates on every refresh, and an `<img src>` carrying it is a new URL
 * each time, so every rotation re-downloaded every cover. This key is stable:
 * an HMAC over the user id and the stored password hash, so a password change
 * rotates it — and revokes every URL minted with the old one — without a table
 * of its own. It authorizes GETs of media only; the middleware enforces that.
 */
const PREFIX = 'mk1';

export const MEDIA_PATH_RE = /^\/api\/(cover|stream|peaks)\//;

export function isMediaKey(token: string): boolean {
  return token.startsWith(`${PREFIX}.`);
}

function sign(secret: string, userId: string, passwordHash: string): string {
  return createHmac('sha256', secret).update(`media:${userId}:${passwordHash}`).digest('base64url');
}

/** The current media key for `userId`, or null when the user does not exist. */
export function mediaKeyFor(db: Database, secret: string, userId: string): string | null {
  const row = db
    .query<{ password_hash: string }, [string]>('SELECT password_hash FROM users WHERE id = ?')
    .get(userId);
  if (!row) return null;
  return `${PREFIX}.${userId}.${sign(secret, userId, row.password_hash)}`;
}

export interface MediaKeyUser {
  sub: string;
  username: string;
  role: string;
}

/** The user a media key belongs to, or null if it is malformed, stale or the account is disabled. */
export function verifyMediaKey(db: Database, secret: string, key: string): MediaKeyUser | null {
  const parts = key.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const [, userId, mac] = parts as [string, string, string];
  const row = db
    .query<{ username: string; role: string; password_hash: string; status: string }, [string]>(
      "SELECT username, role, password_hash, COALESCE(status, 'active') AS status FROM users WHERE id = ?",
    )
    .get(userId);
  if (!row || row.status === 'disabled') return null;
  const expected = Buffer.from(sign(secret, userId, row.password_hash));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return { sub: userId, username: row.username, role: row.role };
}
