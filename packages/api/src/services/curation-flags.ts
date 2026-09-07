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
 * Rows are the record itself: nothing is derived from scanner state.
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
  /** Who raised it: an operator sweep, or somebody listening (issue #987). */
  source: FlagSource;
  /** Distinct listeners who have reported this target; 1 for a curator flag. */
  reportCount: number;
}

export type FlagSource = 'curator' | 'listener';

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
  source?: FlagSource | null;
  report_count?: number | null;
}

const toFlag = (r: FlagRow): CurationFlag => ({
  id: r.id,
  targetKind: r.target_kind,
  targetId: r.target_id,
  reason: r.reason,
  createdBy: r.created_by,
  createdAt: r.created_at,
  source: r.source ?? 'curator',
  reportCount: r.report_count ?? 1,
});

const FLAG_COLUMNS = `id, target_kind, target_id, reason, created_by, created_at, source, report_count`;

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
      `SELECT ${FLAG_COLUMNS}
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
      `SELECT ${FLAG_COLUMNS}
       FROM curation_flags ORDER BY id DESC LIMIT 1`,
    )
    .get();
  return { flag: toFlag(row!), created: true };
}

export interface ListenerReportResult {
  flag: CurationFlag;
  /** False when this folded into a flag that already existed. */
  created: boolean;
  /** True when a curator's own flag was left untouched (see below). */
  deferredToCurator: boolean;
  /** False when this reporter had already reported this target. */
  counted: boolean;
}

/**
 * File a **listener's** report against a target (issue #987).
 *
 * It shares the curator's queue rather than opening a second one — a defect is
 * a defect whoever noticed it, and two worklists is how a backlog goes unread.
 * But it must not go through `createCurationFlag`, which overwrites the reason
 * of any open flag on the target. That is right for an agent re-running its own
 * sweep and wrong twice here: a listener would silently rewrite a **curator's**
 * carefully worded flag, and the tenth reporter would erase the first nine
 * rather than corroborate them.
 *
 * So a curator's flag keeps its wording and only its tally moves — which is
 * still the useful signal, "twelve people agree with you" — while the reporters'
 * own words live in `curation_flag_reports`, one row per person. That table is
 * also the rate limit: a second report from the same person updates their row
 * instead of inflating the count.
 */
export function recordListenerReport(
  db: Database,
  input: {
    targetKind: FlagTargetKind;
    targetId: string;
    /** The flag-facing summary, e.g. `mistagged: year is wrong`. */
    reason: string;
    /** The bare reason id, kept per-reporter for triage. */
    reasonId: string;
    note?: string | null;
    userId: string;
  },
  now = Date.now(),
): ListenerReportResult {
  const already = db
    .query<{ user_id: string }, [string, string, string]>(
      `SELECT user_id FROM curation_flag_reports
       WHERE target_kind = ? AND target_id = ? AND user_id = ?`,
    )
    .get(input.targetKind, input.targetId, input.userId);

  db.run(
    `INSERT INTO curation_flag_reports (target_kind, target_id, user_id, reason, note, at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(target_kind, target_id, user_id)
       DO UPDATE SET reason = excluded.reason, note = excluded.note, at = excluded.at`,
    [input.targetKind, input.targetId, input.userId, input.reasonId, input.note ?? null, now],
  );

  const { n: reporters } = db
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM curation_flag_reports WHERE target_kind = ? AND target_id = ?`,
    )
    .get(input.targetKind, input.targetId)!;

  const existing = db
    .query<FlagRow, [string, string]>(
      `SELECT ${FLAG_COLUMNS} FROM curation_flags
       WHERE target_kind = ? AND target_id = ? AND resolved_at IS NULL`,
    )
    .get(input.targetKind, input.targetId);

  if (!existing) {
    db.run(
      `INSERT INTO curation_flags
         (target_kind, target_id, reason, created_by, created_at, source, report_count)
       VALUES (?, ?, ?, ?, ?, 'listener', ?)`,
      [input.targetKind, input.targetId, input.reason, input.userId, now, reporters],
    );
    const row = db
      .query<FlagRow, []>(`SELECT ${FLAG_COLUMNS} FROM curation_flags ORDER BY id DESC LIMIT 1`)
      .get();
    return { flag: toFlag(row!), created: true, deferredToCurator: false, counted: !already };
  }

  const fromCurator = (existing.source ?? 'curator') === 'curator';
  if (fromCurator) {
    db.run('UPDATE curation_flags SET report_count = ? WHERE id = ?', [reporters, existing.id]);
    return {
      flag: { ...toFlag(existing), reportCount: reporters },
      created: false,
      deferredToCurator: true,
      counted: !already,
    };
  }

  // A reason already present adds nothing but noise; a genuinely new one is
  // corroboration from a different angle and is worth carrying.
  const nextReason = existing.reason.split(' · ').includes(input.reason)
    ? existing.reason
    : `${existing.reason} · ${input.reason}`;
  db.run('UPDATE curation_flags SET reason = ?, report_count = ? WHERE id = ?', [
    nextReason,
    reporters,
    existing.id,
  ]);
  return {
    flag: { ...toFlag(existing), reason: nextReason, reportCount: reporters },
    created: false,
    deferredToCurator: false,
    counted: !already,
  };
}

/** Open flags, oldest first — the queue reads as a to-do list, not a feed. */
export function listOpenCurationFlags(db: Database, limit = 100): CurationFlag[] {
  return db
    .query<FlagRow, [number]>(
      `SELECT ${FLAG_COLUMNS}
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
