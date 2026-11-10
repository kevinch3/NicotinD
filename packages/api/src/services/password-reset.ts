/**
 * Password changes and reset links (docs/email-invitations.md, increment 2).
 *
 * Every path that sets a password also bumps the user's session version, so
 * it doubles as "sign out everywhere": whoever knew the old password is out on
 * their next request, not at their token's expiry 30 days from now.
 *
 * Reset links follow the invite token model — 32 random bytes in the URL
 * fragment, only the sha256 stored, single use — and nothing here knows how a
 * link reaches its user (an admin copies it today; email is a later channel).
 */
import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { asRole, hashPassword, verifyPassword, type Role } from '@nicotind/core';
import { generateInviteToken, hashInviteToken, MIN_INVITE_PASSWORD_LENGTH } from './invites.js';
import { bumpSessionVersion } from './session-version.js';

/** One minimum for every password a person chooses themselves. */
export const MIN_NEW_PASSWORD_LENGTH = MIN_INVITE_PASSWORD_LENGTH;

/** An admin passes the link on by hand, which can take a while. */
export const ADMIN_RESET_TTL_MS = 24 * 3_600_000;

export type ResetStatus = 'valid' | 'invalid' | 'expired' | 'used';

interface ResetRow {
  id: string;
  token_hash: string;
  user_id: string;
  created_by: string | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}

/** Set the hash and end every session; the caller audits. */
async function setPassword(db: Database, userId: string, password: string): Promise<number> {
  const hash = await hashPassword(password);
  db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, userId]);
  return bumpSessionVersion(db, userId);
}

export function issueResetToken(
  db: Database,
  userId: string,
  createdBy: string | null,
  ttlMs: number,
  now: number,
): { token: string; expiresAt: number } | null {
  const exists = db.query('SELECT id FROM users WHERE id = ?').get(userId);
  if (!exists) return null;
  const token = generateInviteToken();
  const expiresAt = now + ttlMs;
  db.transaction(() => {
    // One live link per user: a re-issue kills the previous one.
    db.run('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL', [userId]);
    db.run(
      `INSERT INTO password_resets (id, token_hash, user_id, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [randomUUID(), hashInviteToken(token), userId, createdBy, now, expiresAt],
    );
  })();
  return { token, expiresAt };
}

function findReset(db: Database, token: string): ResetRow | null {
  if (!token) return null;
  return (
    db
      .query<ResetRow, [string]>('SELECT * FROM password_resets WHERE token_hash = ?')
      .get(hashInviteToken(token)) ?? null
  );
}

function statusOf(row: ResetRow | null, now: number): ResetStatus {
  if (!row) return 'invalid';
  if (row.used_at !== null) return 'used';
  if (row.expires_at <= now) return 'expired';
  return 'valid';
}

/** The landing page shows whose password it is about to change. */
export function inspectResetToken(
  db: Database,
  token: string,
  now: number,
): { status: Exclude<ResetStatus, 'valid'> } | { status: 'valid'; username: string } {
  const row = findReset(db, token);
  const status = statusOf(row, now);
  if (status !== 'valid') return { status };
  const user = db
    .query<{ username: string }, [string]>('SELECT username FROM users WHERE id = ?')
    .get(row!.user_id);
  return user ? { status: 'valid', username: user.username } : { status: 'invalid' };
}

export type CompleteResetResult =
  | { ok: true; user: { id: string; username: string; role: Role } }
  | {
      ok: false;
      code:
        'VALIDATION_ERROR' | 'RESET_INVALID' | 'RESET_EXPIRED' | 'RESET_USED' | 'ACCOUNT_DISABLED';
      error: string;
    };

export async function completeReset(
  db: Database,
  input: { token?: unknown; password?: unknown },
  now: number,
): Promise<CompleteResetResult> {
  const token = typeof input.token === 'string' ? input.token : '';
  const password = typeof input.password === 'string' ? input.password : '';
  const row = findReset(db, token);
  const status = statusOf(row, now);
  if (status === 'invalid')
    return { ok: false, code: 'RESET_INVALID', error: 'This reset link is not valid' };
  if (status === 'used')
    return { ok: false, code: 'RESET_USED', error: 'This reset link was already used' };
  if (status === 'expired')
    return { ok: false, code: 'RESET_EXPIRED', error: 'This reset link has expired' };
  if (password.length < MIN_NEW_PASSWORD_LENGTH) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      error: `Password must be at least ${MIN_NEW_PASSWORD_LENGTH} characters`,
    };
  }
  const user = db
    .query<{ id: string; username: string; role: string; status: string }, [string]>(
      "SELECT id, username, role, COALESCE(status, 'active') as status FROM users WHERE id = ?",
    )
    .get(row!.user_id);
  if (!user) return { ok: false, code: 'RESET_INVALID', error: 'This reset link is not valid' };
  if (user.status === 'disabled') {
    return { ok: false, code: 'ACCOUNT_DISABLED', error: 'Account disabled' };
  }
  // Spend first (compare-and-swap), so two tabs racing on one link cannot both
  // set a password.
  const spent = db.run(
    'UPDATE password_resets SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?',
    [now, row!.id, now],
  );
  if (spent.changes === 0) {
    return { ok: false, code: 'RESET_USED', error: 'This reset link was already used' };
  }
  await setPassword(db, user.id, password);
  return { ok: true, user: { id: user.id, username: user.username, role: asRole(user.role) } };
}

export type ChangePasswordResult =
  { ok: true } | { ok: false; code: 'VALIDATION_ERROR' | 'INVALID_CREDENTIALS'; error: string };

/** The signed-in user's own change; proves the old password first. */
export async function changePassword(
  db: Database,
  userId: string,
  input: { currentPassword?: unknown; newPassword?: unknown },
): Promise<ChangePasswordResult> {
  const current = typeof input.currentPassword === 'string' ? input.currentPassword : '';
  const next = typeof input.newPassword === 'string' ? input.newPassword : '';
  if (next.length < MIN_NEW_PASSWORD_LENGTH) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      error: `Password must be at least ${MIN_NEW_PASSWORD_LENGTH} characters`,
    };
  }
  const row = db
    .query<{ password_hash: string }, [string]>('SELECT password_hash FROM users WHERE id = ?')
    .get(userId);
  if (!row || !(await verifyPassword(current, row.password_hash))) {
    return { ok: false, code: 'INVALID_CREDENTIALS', error: 'Current password is incorrect' };
  }
  await setPassword(db, userId, next);
  return { ok: true };
}

/** The admin "set password…" path: no old password, but still ends sessions. */
export async function adminSetPassword(
  db: Database,
  userId: string,
  password: string,
): Promise<boolean> {
  const exists = db.query('SELECT id FROM users WHERE id = ?').get(userId);
  if (!exists) return false;
  await setPassword(db, userId, password);
  return true;
}
