import { randomBytes, createHash, randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';

/**
 * MCP agent tokens (issue #232) — a scoped, revocable bearer credential an
 * external LLM/agent uses to curate a user's library through `/api/mcp`.
 *
 * The token is **opaque** (not a JWT): the row *is* the credential, so revoking
 * is unconditional and instant (contrast a stateless JWT that stays valid until
 * expiry). Only the sha256 hash is stored, so a leak of `agent_tokens` never
 * leaks a live token. The effective role is always **capped at `refiner`** — see
 * `AGENT_EFFECTIVE_ROLE` — so an admin who mints a token does not get an admin
 * agent; MCP curation routes work, server-admin routes 403.
 */

/** Scopes an agent token can carry. `:read` is GET-equivalent; `:curate` adds
 *  writes. Destructive ops (delete/merge) are additionally gated per-call by a
 *  `confirm` flag at the tool layer, not by scope. */
export type AgentScope = 'refiner:read' | 'refiner:curate';

/** Every agent session runs as a refiner, never higher, whatever the owner is. */
export const AGENT_EFFECTIVE_ROLE = 'refiner' as const;

/** Human-visible token prefix so a leaked secret is greppable/identifiable. */
const TOKEN_PREFIX = 'nca_';

export interface AgentTokenRow {
  id: string;
  userId: string;
  name: string;
  scope: AgentScope;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
}

/** The verified identity behind a presented agent token. */
export interface AgentIdentity {
  tokenId: string;
  userId: string;
  scope: AgentScope;
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Mint a token: returns the row id + the raw secret, which is shown to the user
 *  exactly once (only its hash is persisted). `rng`/`now`/`id` are injectable for
 *  tests; production uses crypto randomness. */
export function mintAgentToken(
  db: Database,
  opts: {
    userId: string;
    name: string;
    scope?: AgentScope;
    expiresAt?: number | null;
    now?: number;
    id?: string;
    rawToken?: string;
  },
): { id: string; token: string; scope: AgentScope } {
  const id = opts.id ?? randomUUID();
  const raw = opts.rawToken ?? `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const scope: AgentScope = opts.scope ?? 'refiner:curate';
  db.run(
    `INSERT INTO agent_tokens (id, user_id, name, scope, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.userId,
      opts.name,
      scope,
      hashToken(raw),
      opts.now ?? Date.now(),
      opts.expiresAt ?? null,
    ],
  );
  return { id, token: raw, scope };
}

/**
 * Verify a presented bearer token. Returns the identity, or null when the token
 * is unknown, revoked, or expired. Touches `last_used_at` on success (best
 * effort). Never throws.
 */
export function verifyAgentToken(
  db: Database,
  raw: string | undefined | null,
  now = Date.now(),
): AgentIdentity | null {
  if (!raw || !raw.startsWith(TOKEN_PREFIX)) return null;
  const row = db
    .query<
      {
        id: string;
        user_id: string;
        scope: string;
        expires_at: number | null;
        revoked_at: number | null;
      },
      [string]
    >(`SELECT id, user_id, scope, expires_at, revoked_at FROM agent_tokens WHERE token_hash = ?`)
    .get(hashToken(raw));
  if (!row) return null;
  if (row.revoked_at != null) return null;
  if (row.expires_at != null && row.expires_at <= now) return null;
  try {
    db.run('UPDATE agent_tokens SET last_used_at = ? WHERE id = ?', [now, row.id]);
  } catch {
    /* last_used_at is best-effort telemetry, never block auth on it */
  }
  return { tokenId: row.id, userId: row.user_id, scope: row.scope as AgentScope };
}

/** List a user's tokens (never the hash). Newest first. */
export function listAgentTokens(db: Database, userId: string): AgentTokenRow[] {
  return db
    .query<
      {
        id: string;
        user_id: string;
        name: string;
        scope: string;
        created_at: number;
        last_used_at: number | null;
        expires_at: number | null;
        revoked_at: number | null;
      },
      [string]
    >(
      `SELECT id, user_id, name, scope, created_at, last_used_at, expires_at, revoked_at
       FROM agent_tokens WHERE user_id = ? ORDER BY created_at DESC`,
    )
    .all(userId)
    .map((r) => ({
      id: r.id,
      userId: r.user_id,
      name: r.name,
      scope: r.scope as AgentScope,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      expiresAt: r.expires_at,
      revokedAt: r.revoked_at,
    }));
}

/**
 * Revoke one of the caller's own tokens (stamps `revoked_at`; a stamped token
 * fails `verifyAgentToken` immediately). Scoped to `userId` so a user can never
 * revoke another's token. Returns true when a row was affected.
 */
export function revokeAgentToken(
  db: Database,
  userId: string,
  id: string,
  now = Date.now(),
): boolean {
  const res = db.run(
    'UPDATE agent_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
    [now, id, userId],
  );
  return (res.changes ?? 0) > 0;
}
