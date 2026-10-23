import { randomBytes, createHash, randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';

/**
 * OpenSubsonic API keys (docs/opensubsonic.md). The credential a Subsonic client
 * presents on `/rest/*`, as `apiKey=` (the OpenSubsonic `apiKeyAuthentication`
 * extension) or as the password in legacy `u=&p=` auth.
 *
 * Opaque like the MCP agent tokens: only the sha256 hash is stored, the row is
 * the credential, and revoking is instant. A key acts as its owner with the
 * owner's current role — it is a second way to sign in, not a scoped grant.
 */

/** Greppable prefix, so a key pasted into a log or an issue is recognisable. */
const KEY_PREFIX = 'nss_';
const MAX_KEYS_PER_USER = 20;

export interface SubsonicKeyRow {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface SubsonicKeyOwner {
  keyId: string;
  userId: string;
  username: string;
  role: string;
}

function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export class TooManySubsonicKeysError extends Error {
  constructor() {
    super(`At most ${MAX_KEYS_PER_USER} active keys per user`);
  }
}

/** Mint a key; the raw secret is returned exactly once. */
export function mintSubsonicKey(
  db: Database,
  userId: string,
  name: string,
  now = Date.now(),
): { id: string; key: string } {
  const active =
    db
      .query<{ n: number }, [string]>(
        'SELECT COUNT(*) AS n FROM subsonic_api_keys WHERE user_id = ? AND revoked_at IS NULL',
      )
      .get(userId)?.n ?? 0;
  if (active >= MAX_KEYS_PER_USER) throw new TooManySubsonicKeysError();
  const id = randomUUID();
  const key = `${KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
  db.run(
    `INSERT INTO subsonic_api_keys (id, user_id, name, key_hash, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, userId, name, hashKey(key), now],
  );
  return { id, key };
}

/**
 * The owner behind a presented key, or null when it is unknown, revoked, or its
 * account is disabled. Touches `last_used_at` at most once a minute, so a
 * library sync of thousands of requests is not thousands of writes.
 */
export function verifySubsonicKey(
  db: Database,
  raw: string | undefined | null,
  now = Date.now(),
): SubsonicKeyOwner | null {
  if (!raw || !raw.startsWith(KEY_PREFIX)) return null;
  const row = db
    .query<
      {
        id: string;
        user_id: string;
        username: string;
        role: string;
        status: string;
        last_used_at: number | null;
      },
      [string]
    >(
      `SELECT k.id, k.user_id, u.username, u.role, COALESCE(u.status, 'active') AS status,
              k.last_used_at
       FROM subsonic_api_keys k JOIN users u ON u.id = k.user_id
       WHERE k.key_hash = ? AND k.revoked_at IS NULL`,
    )
    .get(hashKey(raw));
  if (!row || row.status === 'disabled') return null;
  if (row.last_used_at == null || now - row.last_used_at > 60_000) {
    try {
      db.run('UPDATE subsonic_api_keys SET last_used_at = ? WHERE id = ?', [now, row.id]);
    } catch {
      /* telemetry only — never fail a sign-in on it */
    }
  }
  return { keyId: row.id, userId: row.user_id, username: row.username, role: row.role };
}

/** The caller's active keys, newest first (never the hash). */
export function listSubsonicKeys(db: Database, userId: string): SubsonicKeyRow[] {
  return db
    .query<{ id: string; name: string; created_at: number; last_used_at: number | null }, [string]>(
      `SELECT id, name, created_at, last_used_at FROM subsonic_api_keys
       WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
    )
    .all(userId)
    .map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
}

/** Revoke one of the caller's own keys. True when a live key was revoked. */
export function revokeSubsonicKey(
  db: Database,
  userId: string,
  id: string,
  now = Date.now(),
): boolean {
  const res = db.run(
    'UPDATE subsonic_api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
    [now, id, userId],
  );
  return (res.changes ?? 0) > 0;
}
