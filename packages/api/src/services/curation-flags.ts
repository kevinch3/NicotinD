/**
 * Curation review queue (issue #682) — the durable "this needs a human decision"
 * note.
 *
 * A curating agent (or a person) regularly meets a case it can see but must not
 * resolve alone: a `b2b` artist credit naming two acts, a fix whose target is
 * genuinely ambiguous. Before this the only options were **act** (guess) or
 * **say nothing durable** (mention it in a chat transcript nobody re-reads).
 * A flag is the third option, and it is deliberately inert — flagging changes
 * no library data, it only records that a decision is owed.
 *
 * The counterpart for *pre-landing* downloads is `download_reviews`
 * (docs/download-review.md), whose pending set is derived from scanner state.
 * This one is post-landing and its rows are the record itself, so it is a
 * separate table rather than a widening of that one.
 */
import type { Database } from 'bun:sqlite';

export type FlagTargetKind = 'artist' | 'album' | 'song';

export interface CurationFlag {
  id: number;
  targetKind: FlagTargetKind;
  targetId: string;
  reason: string;
  createdBy: string;
  createdAt: number;
}

export const FLAG_TARGET_KINDS: readonly FlagTargetKind[] = ['artist', 'album', 'song'];

export function isFlagTargetKind(v: unknown): v is FlagTargetKind {
  return typeof v === 'string' && (FLAG_TARGET_KINDS as readonly string[]).includes(v);
}

interface FlagRow {
  id: number;
  target_kind: FlagTargetKind;
  target_id: string;
  reason: string;
  created_by: string;
  created_at: number;
}

const toFlag = (r: FlagRow): CurationFlag => ({
  id: r.id,
  targetKind: r.target_kind,
  targetId: r.target_id,
  reason: r.reason,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

export interface CreateFlagResult {
  flag: CurationFlag;
  /** False when an open flag for this target already existed (its reason is
   *  refreshed rather than a duplicate row being minted). */
  created: boolean;
}

/**
 * Flag a target for human review. Re-flagging a target that already has an OPEN
 * flag updates that row's reason instead of adding a second one — an agent's
 * repeated sweep must not turn one unresolved ambiguity into a growing pile.
 */
export function createCurationFlag(
  db: Database,
  input: { targetKind: FlagTargetKind; targetId: string; reason: string; createdBy: string },
  now = Date.now(),
): CreateFlagResult {
  const existing = db
    .query<FlagRow, [string, string]>(
      `SELECT id, target_kind, target_id, reason, created_by, created_at
       FROM curation_flags
       WHERE target_kind = ? AND target_id = ? AND resolved_at IS NULL`,
    )
    .get(input.targetKind, input.targetId);

  if (existing) {
    db.run('UPDATE curation_flags SET reason = ? WHERE id = ?', [input.reason, existing.id]);
    return { flag: { ...toFlag(existing), reason: input.reason }, created: false };
  }

  db.run(
    `INSERT INTO curation_flags (target_kind, target_id, reason, created_by, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [input.targetKind, input.targetId, input.reason, input.createdBy, now],
  );
  const row = db
    .query<FlagRow, []>(
      `SELECT id, target_kind, target_id, reason, created_by, created_at
       FROM curation_flags ORDER BY id DESC LIMIT 1`,
    )
    .get();
  return { flag: toFlag(row!), created: true };
}

/** Open flags, oldest first — the queue reads as a to-do list, not a feed. */
export function listOpenCurationFlags(db: Database, limit = 100): CurationFlag[] {
  return db
    .query<FlagRow, [number]>(
      `SELECT id, target_kind, target_id, reason, created_by, created_at
       FROM curation_flags WHERE resolved_at IS NULL
       ORDER BY created_at, id LIMIT ?`,
    )
    .all(Math.max(1, Math.min(500, Math.floor(limit))))
    .map(toFlag);
}

export function countOpenCurationFlags(db: Database): number {
  return Number(
    db
      .query<{ n: number }, []>(
        'SELECT COUNT(*) AS n FROM curation_flags WHERE resolved_at IS NULL',
      )
      .get()?.n ?? 0,
  );
}

/**
 * Mark a flag handled. Returns false for an unknown id or one already resolved —
 * resolving is idempotent from the caller's side but never silently re-stamps
 * who resolved it.
 */
export function resolveCurationFlag(
  db: Database,
  id: number,
  resolvedBy: string,
  now = Date.now(),
): boolean {
  const res = db.run(
    'UPDATE curation_flags SET resolved_at = ?, resolved_by = ? WHERE id = ? AND resolved_at IS NULL',
    [now, resolvedBy, id],
  );
  return Number(res.changes ?? 0) > 0;
}
