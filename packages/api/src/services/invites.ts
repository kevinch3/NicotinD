/**
 * Invitations (docs/email-invitations.md): an admin mints a link, a friend opens
 * it and creates their own account at the role the admin chose — the one way in
 * while public signup is closed.
 *
 * The link is the primitive; email is only one way to deliver it. An emailed
 * invite (increment 4) records its recipient so accepting it can set the new
 * account's address, already verified — but sending is the route's job, through
 * `MailService`, and nothing here knows how mail goes out.
 *
 * Token handling follows `agent_tokens`, not `pairing_tokens`: 32 random bytes,
 * only the sha256 stored, shown once at mint. An invite lives for days rather
 * than minutes, so a leaked table must never leak a live link.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { asRole, hashPassword, ROLES, type Role } from '@nicotind/core';
import { emailTaken, parseOptionalEmail } from './user-email.js';

/** Allowed lifetimes, in hours — a closed set so the UI and API cannot drift. */
export const INVITE_EXPIRY_HOURS = [24, 168, 720] as const;
export type InviteExpiryHours = (typeof INVITE_EXPIRY_HOURS)[number];
export const DEFAULT_INVITE_EXPIRY_HOURS: InviteExpiryHours = 168;

/** Multi-use is capped, never unlimited: a leaked link must run out. */
export const MAX_INVITE_USES = 25;

/** New accounts get a real minimum; the legacy admin "set password" keeps 4. */
export const MIN_INVITE_PASSWORD_LENGTH = 8;
export const MAX_USERNAME_LENGTH = 64;
const MAX_NOTE_LENGTH = 200;

export type InviteStatus = 'pending' | 'used' | 'expired' | 'revoked';

export interface InviteRow {
  id: string;
  token_hash: string;
  role: string;
  note: string | null;
  created_by: string | null;
  created_at: number;
  expires_at: number;
  max_uses: number;
  use_count: number;
  revoked_at: number | null;
  last_used_at: number | null;
  email: string | null;
}

export interface InviteSummary {
  id: string;
  role: Role;
  note: string | null;
  createdBy: string | null;
  createdAt: number;
  expiresAt: number;
  maxUses: number;
  useCount: number;
  revokedAt: number | null;
  status: InviteStatus;
  acceptedBy: string[];
  /** The recipient of an emailed invite; null for a link invite. */
  email: string | null;
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateInviteToken(random: typeof randomBytes = randomBytes): string {
  return random(32).toString('base64url');
}

/**
 * Revoked wins over everything (the admin's latest word), then used-up, then
 * expired. Pure so the ordering is pinned by a unit test rather than by SQL.
 */
export function inviteStatus(
  row: Pick<InviteRow, 'revoked_at' | 'use_count' | 'max_uses' | 'expires_at'>,
  now: number,
): InviteStatus {
  if (row.revoked_at !== null) return 'revoked';
  if (row.use_count >= row.max_uses) return 'used';
  if (row.expires_at <= now) return 'expired';
  return 'pending';
}

export interface CreateInviteInput {
  role?: unknown;
  expiresInHours?: unknown;
  maxUses?: unknown;
  note?: unknown;
  /** Optional recipient; given, the invite is single-use and accepting it verifies the address. */
  email?: unknown;
}

export type CreateInviteResult =
  | { ok: true; invite: InviteSummary; token: string }
  | { ok: false; code: 'VALIDATION_ERROR' | 'EMAIL_TAKEN'; error: string };

export function createInvite(
  db: Database,
  creatorId: string,
  input: CreateInviteInput,
  now: number,
): CreateInviteResult {
  const role = input.role === undefined ? 'user' : input.role;
  if (typeof role !== 'string' || !(ROLES as readonly string[]).includes(role)) {
    return { ok: false, code: 'VALIDATION_ERROR', error: 'Unknown role' };
  }
  const hours = input.expiresInHours ?? DEFAULT_INVITE_EXPIRY_HOURS;
  if (!(INVITE_EXPIRY_HOURS as readonly unknown[]).includes(hours)) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      error: `expiresInHours must be one of ${INVITE_EXPIRY_HOURS.join(', ')}`,
    };
  }
  const maxUses = input.maxUses ?? 1;
  if (
    typeof maxUses !== 'number' ||
    !Number.isInteger(maxUses) ||
    maxUses < 1 ||
    maxUses > MAX_INVITE_USES
  ) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      error: `maxUses must be an integer from 1 to ${MAX_INVITE_USES}`,
    };
  }
  let note: string | null = null;
  if (input.note !== undefined && input.note !== null) {
    if (typeof input.note !== 'string') {
      return { ok: false, code: 'VALIDATION_ERROR', error: 'note must be a string' };
    }
    note = input.note.trim().slice(0, MAX_NOTE_LENGTH) || null;
  }
  const parsedEmail = parseOptionalEmail(input.email);
  if (!parsedEmail.ok) return { ok: false, code: 'VALIDATION_ERROR', error: parsedEmail.error };
  const email = parsedEmail.email;
  if (email !== null) {
    // One address, one account: a second use could never carry it.
    if (maxUses !== 1) {
      return { ok: false, code: 'VALIDATION_ERROR', error: 'An emailed invite is single-use' };
    }
    if (emailTaken(db, email)) {
      return { ok: false, code: 'EMAIL_TAKEN', error: 'An account already uses this email' };
    }
  }

  const id = randomUUID();
  const token = generateInviteToken();
  const expiresAt = now + (hours as number) * 3_600_000;
  db.run(
    `INSERT INTO invites (id, token_hash, role, note, created_by, created_at, expires_at, max_uses, email)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, hashInviteToken(token), role, note, creatorId, now, expiresAt, maxUses, email],
  );
  return { ok: true, invite: getInviteSummary(db, id, now)!, token };
}

function summarize(db: Database, row: InviteRow, now: number): InviteSummary {
  const creator = row.created_by
    ? db
        .query<{ username: string }, [string]>('SELECT username FROM users WHERE id = ?')
        .get(row.created_by)
    : null;
  const accepted = db
    .query<{ username: string }, [string]>(
      `SELECT u.username FROM invite_acceptances a JOIN users u ON u.id = a.user_id
       WHERE a.invite_id = ? ORDER BY a.accepted_at`,
    )
    .all(row.id)
    .map((r) => r.username);
  return {
    id: row.id,
    role: asRole(row.role),
    note: row.note,
    createdBy: creator?.username ?? null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    maxUses: row.max_uses,
    useCount: row.use_count,
    revokedAt: row.revoked_at,
    status: inviteStatus(row, now),
    acceptedBy: accepted,
    email: row.email ?? null,
  };
}

export function getInviteSummary(db: Database, id: string, now: number): InviteSummary | null {
  const row = db.query<InviteRow, [string]>('SELECT * FROM invites WHERE id = ?').get(id);
  return row ? summarize(db, row, now) : null;
}

/** How long a finished (used/expired/revoked) invite stays visible in the list. */
export const FINISHED_INVITE_VISIBLE_MS = 7 * 24 * 3_600_000;

/**
 * Pending first, newest first; finished invites stay listed for a week so the
 * admin can see what happened to them, then drop out of the list (the rows and
 * the audit log keep the history).
 */
export function listInvites(db: Database, now: number): InviteSummary[] {
  const rows = db
    .query<InviteRow, []>('SELECT * FROM invites ORDER BY created_at DESC')
    .all()
    .map((row) => summarize(db, row, now));
  const finishedAt = (s: InviteSummary): number =>
    s.status === 'revoked'
      ? (s.revokedAt ?? s.createdAt)
      : s.status === 'expired'
        ? s.expiresAt
        : s.createdAt;
  const visible = rows.filter(
    (s) => s.status === 'pending' || now - finishedAt(s) < FINISHED_INVITE_VISIBLE_MS,
  );
  return [
    ...visible.filter((s) => s.status === 'pending'),
    ...visible.filter((s) => s.status !== 'pending'),
  ];
}

/** Idempotent: revoking a revoked invite keeps the first timestamp. */
export function revokeInvite(db: Database, id: string, now: number): InviteSummary | null {
  db.run('UPDATE invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [now, id]);
  return getInviteSummary(db, id, now);
}

export type RotateInviteResult =
  | { ok: true; invite: InviteSummary; token: string }
  | { ok: false; code: 'NOT_FOUND' | 'INVITE_NOT_PENDING' };

/**
 * A fresh link for a still-pending invite. The old link dies with its hash —
 * this is what "copy the link again" means when only the hash is stored.
 */
export function rotateInviteToken(db: Database, id: string, now: number): RotateInviteResult {
  const row = db.query<InviteRow, [string]>('SELECT * FROM invites WHERE id = ?').get(id);
  if (!row) return { ok: false, code: 'NOT_FOUND' };
  if (inviteStatus(row, now) !== 'pending') return { ok: false, code: 'INVITE_NOT_PENDING' };
  const token = generateInviteToken();
  db.run('UPDATE invites SET token_hash = ? WHERE id = ?', [hashInviteToken(token), id]);
  return { ok: true, invite: getInviteSummary(db, id, now)!, token };
}

function findByToken(db: Database, token: string): InviteRow | null {
  if (!token) return null;
  return (
    db
      .query<InviteRow, [string]>('SELECT * FROM invites WHERE token_hash = ?')
      .get(hashInviteToken(token)) ?? null
  );
}

export type InspectResult =
  | { status: 'invalid' }
  | { status: Exclude<InviteStatus, 'pending'>; invitedBy: string | null }
  | {
      status: 'pending';
      invitedBy: string | null;
      role: Role;
      expiresAt: number;
      /** The address an emailed invite was sent to — the account gets it, verified. */
      email: string | null;
    };

/** What the public landing page may know before the invitee commits. */
export function inspectInvite(db: Database, token: string, now: number): InspectResult {
  const row = findByToken(db, token);
  if (!row) return { status: 'invalid' };
  const summary = summarize(db, row, now);
  if (summary.status !== 'pending') {
    return { status: summary.status, invitedBy: summary.createdBy };
  }
  return {
    status: 'pending',
    invitedBy: summary.createdBy,
    role: summary.role,
    expiresAt: summary.expiresAt,
    email: summary.email,
  };
}

export type AcceptInviteResult =
  | {
      ok: true;
      user: { id: string; username: string; role: Role };
      inviteId: string;
      /** The emailed invite's address, now on the account and verified; null otherwise. */
      email: string | null;
    }
  | {
      ok: false;
      code:
        | 'VALIDATION_ERROR'
        | 'INVITE_INVALID'
        | 'INVITE_EXPIRED'
        | 'INVITE_USED'
        | 'INVITE_REVOKED'
        | 'USERNAME_TAKEN';
      error: string;
    };

export async function acceptInvite(
  db: Database,
  input: { token?: unknown; username?: unknown; password?: unknown },
  now: number,
): Promise<AcceptInviteResult> {
  const token = typeof input.token === 'string' ? input.token : '';
  const username = typeof input.username === 'string' ? input.username.trim() : '';
  const password = typeof input.password === 'string' ? input.password : '';

  const row = findByToken(db, token);
  if (!row) return { ok: false, code: 'INVITE_INVALID', error: 'This invite is not valid' };
  const status = inviteStatus(row, now);
  if (status === 'revoked') {
    return { ok: false, code: 'INVITE_REVOKED', error: 'This invite was revoked' };
  }
  if (status === 'used') {
    return { ok: false, code: 'INVITE_USED', error: 'This invite has already been used' };
  }
  if (status === 'expired') {
    return { ok: false, code: 'INVITE_EXPIRED', error: 'This invite has expired' };
  }

  if (!username || username.length > MAX_USERNAME_LENGTH || /\s/.test(username)) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      error: `Username must be 1–${MAX_USERNAME_LENGTH} characters with no spaces`,
    };
  }
  if (password.length < MIN_INVITE_PASSWORD_LENGTH) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      error: `Password must be at least ${MIN_INVITE_PASSWORD_LENGTH} characters`,
    };
  }

  // Hashed before the transaction: argon2/bcrypt is async and slow, and a
  // bun:sqlite transaction is synchronous.
  const passwordHash = await hashPassword(password);
  const id = randomUUID();
  const role = asRole(row.role);

  const outcome = db.transaction((): AcceptInviteResult => {
    const taken = db
      .query<{ id: string }, [string]>('SELECT id FROM users WHERE username = ?')
      .get(username);
    if (taken) return { ok: false, code: 'USERNAME_TAKEN', error: 'Username already taken' };
    // Compare-and-swap: re-checks every condition at write time, so a revoke or
    // a concurrent accept between the read above and here cannot be overspent.
    const spent = db.run(
      `UPDATE invites SET use_count = use_count + 1, last_used_at = ?
       WHERE id = ? AND revoked_at IS NULL AND use_count < max_uses AND expires_at > ?`,
      [now, row.id, now],
    );
    if (spent.changes === 0) {
      return { ok: false, code: 'INVITE_USED', error: 'This invite has already been used' };
    }
    // An emailed invite proves the address: the link only reached that inbox.
    // Should another account have claimed it since the invite was sent, the
    // account is still created — without the address, which its owner can add
    // from Settings → Account — rather than stranding the invitee.
    const email = row.email && !emailTaken(db, row.email) ? row.email : null;
    db.run(
      `INSERT INTO users (id, username, password_hash, role, email, email_verified_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, username, passwordHash, role, email, email ? now : null],
    );
    db.run('INSERT INTO user_settings (user_id) VALUES (?)', [id]);
    db.run('INSERT INTO invite_acceptances (invite_id, user_id, accepted_at) VALUES (?, ?, ?)', [
      row.id,
      id,
      now,
    ]);
    return { ok: true, user: { id, username, role }, inviteId: row.id, email };
  })();
  return outcome;
}
