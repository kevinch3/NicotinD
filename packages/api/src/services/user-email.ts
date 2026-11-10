/**
 * A user's email address (docs/email-invitations.md, increments 4–5).
 *
 * One spelling everywhere: trimmed and lower-cased before it is compared or
 * stored, so `Friend@Example.com` and `friend@example.com` are one address to
 * the unique index on `users.email`. (Strictly, the local part is
 * case-sensitive; no provider a self-hoster will meet treats it so, and two
 * accounts differing only by case would be a support trap.)
 */
import type { Database } from 'bun:sqlite';
import { looksLikeEmail } from './mail/settings.js';

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export type ParsedEmail =
  { ok: true; email: string } | { ok: true; email: null } | { ok: false; error: string };

/**
 * An optional email field from a request body: absent, null or blank reads as
 * "none" (`email: null`); anything else must look like an address.
 */
export function parseOptionalEmail(value: unknown): ParsedEmail {
  if (value === undefined || value === null) return { ok: true, email: null };
  if (typeof value !== 'string') return { ok: false, error: 'email must be a string' };
  const email = normalizeEmail(value);
  if (!email) return { ok: true, email: null };
  if (!looksLikeEmail(email)) return { ok: false, error: 'email must be an email address' };
  return { ok: true, email };
}

/** Whether an account other than `exceptUserId` already has this address. */
export function emailTaken(db: Database, email: string, exceptUserId?: string): boolean {
  const row = db
    .query<{ id: string }, [string]>('SELECT id FROM users WHERE email = ?')
    .get(normalizeEmail(email));
  return !!row && row.id !== exceptUserId;
}

export interface UserEmail {
  email: string | null;
  verified: boolean;
}

export function userEmailOf(db: Database, userId: string): UserEmail {
  const row = db
    .query<{ email: string | null; email_verified_at: number | null }, [string]>(
      'SELECT email, email_verified_at FROM users WHERE id = ?',
    )
    .get(userId);
  return { email: row?.email ?? null, verified: row?.email_verified_at != null };
}

/** The address a reset link or a notice may go to: only ever a verified one. */
export function verifiedEmailOf(db: Database, userId: string): string | null {
  const { email, verified } = userEmailOf(db, userId);
  return email && verified ? email : null;
}
