/**
 * Email verification links (docs/email-invitations.md, increment 5).
 *
 * A user asks for a new address; the address waits in `email_verifications`
 * with a hashed, single-use, 24-hour token, and `users.email` changes only when
 * the link is opened — so a typo never replaces a working address, and only a
 * proven address can ever receive a reset link. Tokens follow the invite model
 * (32 random bytes in the URL fragment, only the sha256 stored).
 */
import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { generateInviteToken, hashInviteToken } from './invites.js';
import { emailTaken, normalizeEmail } from './user-email.js';

export const EMAIL_VERIFY_TTL_MS = 24 * 3_600_000;

interface VerificationRow {
  id: string;
  user_id: string;
  email: string;
  token_hash: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}

/** Start (or restart) a verification; the previous live link of this user dies. */
export function startEmailVerification(
  db: Database,
  userId: string,
  email: string,
  now: number,
): { token: string; expiresAt: number } {
  const token = generateInviteToken();
  const expiresAt = now + EMAIL_VERIFY_TTL_MS;
  db.transaction(() => {
    db.run('DELETE FROM email_verifications WHERE user_id = ? AND used_at IS NULL', [userId]);
    db.run(
      `INSERT INTO email_verifications (id, user_id, email, token_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [randomUUID(), userId, normalizeEmail(email), hashInviteToken(token), now, expiresAt],
    );
  })();
  return { token, expiresAt };
}

/** Drop a pending change — the user cleared their address or picked another way. */
export function cancelEmailVerification(db: Database, userId: string): void {
  db.run('DELETE FROM email_verifications WHERE user_id = ? AND used_at IS NULL', [userId]);
}

/** The address waiting for its link to be opened, if the link is still live. */
export function pendingEmailOf(db: Database, userId: string, now: number): string | null {
  return (
    db
      .query<{ email: string }, [string, number]>(
        `SELECT email FROM email_verifications
         WHERE user_id = ? AND used_at IS NULL AND expires_at > ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(userId, now)?.email ?? null
  );
}

export type VerifyEmailResult =
  | { ok: true; userId: string; email: string }
  | { ok: false; code: 'VERIFY_INVALID' | 'VERIFY_EXPIRED' | 'VERIFY_USED' | 'EMAIL_TAKEN' };

/**
 * Spend the link and set the address. The spend is a compare-and-swap inside
 * the transaction that writes `users`, so two tabs cannot both apply it; an
 * address another account took meanwhile refuses with `EMAIL_TAKEN` and
 * leaves the link unspent (nothing was changed — the user can pick another).
 */
export function completeEmailVerification(
  db: Database,
  token: string,
  now: number,
): VerifyEmailResult {
  if (!token) return { ok: false, code: 'VERIFY_INVALID' };
  const row = db
    .query<VerificationRow, [string]>('SELECT * FROM email_verifications WHERE token_hash = ?')
    .get(hashInviteToken(token));
  if (!row) return { ok: false, code: 'VERIFY_INVALID' };
  if (row.used_at !== null) return { ok: false, code: 'VERIFY_USED' };
  if (row.expires_at <= now) return { ok: false, code: 'VERIFY_EXPIRED' };

  return db.transaction((): VerifyEmailResult => {
    if (emailTaken(db, row.email, row.user_id)) return { ok: false, code: 'EMAIL_TAKEN' };
    const spent = db.run(
      'UPDATE email_verifications SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?',
      [now, row.id, now],
    );
    if (spent.changes === 0) return { ok: false, code: 'VERIFY_USED' };
    const updated = db.run('UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?', [
      row.email,
      now,
      row.user_id,
    ]);
    if (updated.changes === 0) return { ok: false, code: 'VERIFY_INVALID' };
    return { ok: true, userId: row.user_id, email: row.email };
  })();
}
