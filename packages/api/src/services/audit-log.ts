/**
 * Admin audit log: who did which destructive/curation action to what, when.
 * With the refiner role, destructive actions are multi-user — this gives
 * admins a durable record instead of grepping server logs (HA/Immich keep
 * comparable admin-visible activity records).
 *
 * Writes are explicit at the mutation sites (album delete, bulk song delete,
 * artist identity, user management) with meaningful action names — not a
 * blanket mutation middleware, which would drown the log in per-listener
 * noise (stars, lyric edits). Failures never break the mutating request.
 */
import type { Database } from 'bun:sqlite';
import type { JwtPayload } from '@nicotind/core';
import { createLogger } from '@nicotind/core';

const log = createLogger('audit');

export interface AuditEntry {
  id: number;
  at: number;
  userId: string;
  username: string | null;
  action: string;
  targetKind: string | null;
  targetId: string | null;
  detail: string | null;
}

export function recordAudit(
  db: Database,
  actor: Pick<JwtPayload, 'sub' | 'username'>,
  action: string,
  opts: { targetKind?: string; targetId?: string; detail?: string; now?: number } = {},
): void {
  try {
    db.run(
      `INSERT INTO audit_log (at, user_id, username, action, target_kind, target_id, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        opts.now ?? Date.now(),
        actor.sub,
        actor.username ?? null,
        action,
        opts.targetKind ?? null,
        opts.targetId ?? null,
        opts.detail ?? null,
      ],
    );
  } catch (err) {
    // The audited action must never fail because the ledger write did.
    log.error({ err, action }, 'audit write failed');
  }
}

export function listAudit(
  db: Database,
  opts: { limit?: number; offset?: number } = {},
): AuditEntry[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  return db
    .query<
      {
        id: number;
        at: number;
        user_id: string;
        username: string | null;
        action: string;
        target_kind: string | null;
        target_id: string | null;
        detail: string | null;
      },
      [number, number]
    >(
      `SELECT id, at, user_id, username, action, target_kind, target_id, detail
       FROM audit_log ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(limit, offset)
    .map((r) => ({
      id: r.id,
      at: r.at,
      userId: r.user_id,
      username: r.username,
      action: r.action,
      targetKind: r.target_kind,
      targetId: r.target_id,
      detail: r.detail,
    }));
}
