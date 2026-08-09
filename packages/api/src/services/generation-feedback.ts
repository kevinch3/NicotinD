/**
 * Generation-feedback persistence: capture, grade, and export the (input, output,
 * verdict) snapshots that back the dev golden-dataset (docs/generation-feedback.md).
 *
 * A snapshot is recorded PENDING (verdict NULL) at generation time — e.g. when a
 * hunt renders — and RESOLVED later when the admin taps 👍/👎 on the capture toast.
 * All writes are guarded so a ledger failure never breaks the generation it wraps,
 * mirroring recordAudit (services/audit-log.ts).
 */
import type { Database } from 'bun:sqlite';
import {
  createLogger,
  type GenerationFeedbackResourceType,
  type GenerationFeedbackRecord,
  type GenerationFeedbackSummary,
  type GenerationVerdict,
  type HuntMatchItemFlags,
  type HuntMatchInput,
  type HuntMatchOutput,
  type HuntMatchFixture,
  type SnapshotFolderCandidate,
  type FolderRef,
} from '@nicotind/core';

const log = createLogger('generation-feedback');

// Pending rows the admin never graded are abandoned hunts — prune them so the
// table doesn't accumulate. Opportunistically swept on each new insert.
// 30 days, not 24h: grading happens in the Admin review queue on the admin's own
// schedule, and a one-day window silently deleted every capture before it was
// ever looked at (issue #451 — prod kept 2 of ~39).
export const PENDING_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface RecordPendingInput {
  userId: string;
  username?: string | null;
  resourceType: GenerationFeedbackResourceType;
  resourceRef?: string | null;
  /** The generation INPUT snapshot (e.g. HuntMatchInput). Stored as JSON. */
  input: unknown;
  /** The generation OUTPUT snapshot (e.g. HuntMatchOutput). Stored as JSON. */
  output: unknown;
  engineVersion?: string | null;
  now?: number;
}

/**
 * Record a pending (ungraded) feedback snapshot. Returns the new row id (or 0 on a
 * guarded failure — the caller threads it to the client so the grading toast can
 * PATCH it, and a 0 simply means "no toast"). Opportunistically prunes stale
 * pending rows.
 */
export function recordPendingFeedback(db: Database, input: RecordPendingInput): number {
  try {
    const now = input.now ?? Date.now();
    db.run(`DELETE FROM generation_feedback WHERE verdict IS NULL AND at < ?`, [
      now - PENDING_TTL_MS,
    ]);
    const row = db
      .query<
        { id: number },
        [number, string, string | null, string, string | null, string, string, string | null]
      >(
        `INSERT INTO generation_feedback
           (at, user_id, username, resource_type, resource_ref, input_json, output_json, engine_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
      )
      .get(
        now,
        input.userId,
        input.username ?? null,
        input.resourceType,
        input.resourceRef ?? null,
        JSON.stringify(input.input),
        JSON.stringify(input.output),
        input.engineVersion ?? null,
      );
    return row?.id ?? 0;
  } catch (err) {
    log.error({ err, resourceType: input.resourceType }, 'feedback capture failed');
    return 0;
  }
}

export interface ResolveInput {
  verdict: GenerationVerdict;
  note?: string;
  itemFlags?: HuntMatchItemFlags;
}

/**
 * Grade a pending snapshot. Only the row's owner can resolve it, and only while it
 * is still pending (verdict IS NULL). Returns whether a row was updated.
 */
export function resolveFeedback(
  db: Database,
  id: number,
  userId: string,
  input: ResolveInput,
): boolean {
  try {
    const res = db.run(
      `UPDATE generation_feedback
         SET verdict = ?, note = ?, item_flags_json = ?
       WHERE id = ? AND user_id = ? AND verdict IS NULL`,
      [
        input.verdict,
        input.note ?? null,
        input.itemFlags ? JSON.stringify(input.itemFlags) : null,
        id,
        userId,
      ],
    );
    return res.changes > 0;
  } catch (err) {
    log.error({ err, id }, 'feedback resolve failed');
    return false;
  }
}

/**
 * Whether the admin dev-mode capture toggle is on for a user. Gates whether a
 * generation records a pending row + tells the client to show the grading toast.
 */
export function feedbackCaptureEnabled(db: Database, userId: string): boolean {
  const row = db
    .query<{ feedback_capture: number }, [string]>(
      `SELECT COALESCE(feedback_capture, 0) AS feedback_capture FROM user_settings WHERE user_id = ?`,
    )
    .get(userId);
  return (row?.feedback_capture ?? 0) === 1;
}

export interface CaptureHuntArgs {
  input: HuntMatchInput;
  /** Raw slskd responses — opaque snapshot payload (serialized as-is). */
  rawResponses: unknown[];
  candidates: SnapshotFolderCandidate[];
  chosen?: FolderRef | null;
  engineVersion?: string | null;
}

/**
 * Capture a hunt's proposal↔recognition pair as a pending feedback row — but ONLY
 * when the requester is an admin with the dev-mode capture toggle on. Returns the
 * new row id for the client's grading toast, or 0 (no capture / not gated in).
 * why: recording for every hunt would fill the table with never-graded rows; the
 * gate scopes capture to exactly the sessions where an admin will grade.
 */
export function captureHuntMatchFeedback(
  db: Database,
  user: { sub: string; username?: string | null; role?: string },
  args: CaptureHuntArgs,
): number {
  if (user.role !== 'admin' || !feedbackCaptureEnabled(db, user.sub)) return 0;
  return recordPendingFeedback(db, {
    userId: user.sub,
    username: user.username ?? null,
    resourceType: 'hunt-match',
    resourceRef: args.input.lidarrAlbumId != null ? String(args.input.lidarrAlbumId) : null,
    input: args.input,
    output: {
      rawResponses: args.rawResponses,
      candidates: args.candidates,
      chosen: args.chosen ?? null,
    },
    engineVersion: args.engineVersion,
  });
}

/**
 * Distill a graded hunt-match record into a replayable fixture, or null if it
 * isn't a graded hunt-match. The "expected correct folder" is the human truth:
 * for 👍 it's the folder the recognizer already ranked #1 (a must-stay-correct
 * regression); for 👎 it's `itemFlags.correctFolder` (the folder the recognizer
 * SHOULD rank #1 — the bug the fixture guards). Used by scripts/feedback-to-fixtures.ts.
 */
export function huntFixtureFromRecord(record: GenerationFeedbackRecord): HuntMatchFixture | null {
  if (record.resourceType !== 'hunt-match' || !record.verdict) return null;
  const input = record.input as HuntMatchInput | null;
  const output = record.output as HuntMatchOutput | null;
  if (!input || !output) return null;

  const correctFolder: FolderRef | null =
    record.verdict === 'good'
      ? output.candidates[0]
        ? { username: output.candidates[0].username, directory: output.candidates[0].directory }
        : null
      : (record.itemFlags?.correctFolder ?? null);

  return {
    canonicalTracks: input.canonicalTracks.map((t) => ({ title: t.title })),
    rawResponses: output.rawResponses,
    expected: { correctFolder },
    meta: {
      id: record.id,
      verdict: record.verdict,
      artistName: input.artistName,
      albumTitle: input.albumTitle,
    },
  };
}

interface FeedbackRow {
  id: number;
  at: number;
  user_id: string;
  username: string | null;
  resource_type: string;
  resource_ref: string | null;
  verdict: string | null;
  note: string | null;
  input_json: string;
  output_json: string;
  item_flags_json: string | null;
  engine_version: string | null;
}

function safeParse<T>(json: string | null): T | null {
  if (json == null) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

function toRecord(r: FeedbackRow): GenerationFeedbackRecord {
  return {
    id: r.id,
    at: r.at,
    userId: r.user_id,
    username: r.username,
    resourceType: r.resource_type as GenerationFeedbackResourceType,
    resourceRef: r.resource_ref,
    verdict: r.verdict as GenerationVerdict | null,
    note: r.note,
    input: safeParse(r.input_json),
    output: safeParse(r.output_json),
    itemFlags: safeParse<HuntMatchItemFlags>(r.item_flags_json),
    engineVersion: r.engine_version,
  };
}

export interface ListFeedbackOptions {
  resourceType?: GenerationFeedbackResourceType;
  /** true = graded only, false = pending only, undefined = all. */
  graded?: boolean;
  limit?: number;
  offset?: number;
}

/** The WHERE/LIMIT half both list queries share, so their filters can't drift. */
function buildListQuery(opts: ListFeedbackOptions): {
  whereSql: string;
  params: (string | number)[];
} {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  const offset = Math.max(opts.offset ?? 0, 0);
  const wheres: string[] = [];
  const params: (string | number)[] = [];
  if (opts.resourceType) {
    wheres.push('resource_type = ?');
    params.push(opts.resourceType);
  }
  if (opts.graded === true) wheres.push('verdict IS NOT NULL');
  if (opts.graded === false) wheres.push('verdict IS NULL');
  params.push(limit, offset);
  return { whereSql: wheres.length ? `WHERE ${wheres.join(' AND ')}` : '', params };
}

export function listFeedback(db: Database, opts: ListFeedbackOptions): GenerationFeedbackRecord[] {
  const { whereSql, params } = buildListQuery(opts);
  return db
    .query<FeedbackRow, (string | number)[]>(
      `SELECT id, at, user_id, username, resource_type, resource_ref, verdict, note,
              input_json, output_json, item_flags_json, engine_version
         FROM generation_feedback ${whereSql}
         ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params)
    .map(toRecord);
}

type SummaryRow = Omit<FeedbackRow, 'user_id' | 'output_json' | 'item_flags_json'>;

/**
 * The Admin review queue's read model. Selects `input_json` (small — the proposal)
 * but never `output_json`, which holds the verbatim slskd responses and is 251 KB
 * on a real prod row. See GenerationFeedbackSummary.
 */
export function listFeedbackSummaries(
  db: Database,
  opts: ListFeedbackOptions,
): GenerationFeedbackSummary[] {
  const { whereSql, params } = buildListQuery(opts);
  return db
    .query<SummaryRow, (string | number)[]>(
      `SELECT id, at, username, resource_type, resource_ref, verdict, note,
              input_json, engine_version
         FROM generation_feedback ${whereSql}
         ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params)
    .map((r) => {
      const input = safeParse<Partial<HuntMatchInput>>(r.input_json);
      return {
        id: r.id,
        at: r.at,
        username: r.username,
        resourceType: r.resource_type as GenerationFeedbackResourceType,
        resourceRef: r.resource_ref,
        verdict: r.verdict as GenerationVerdict | null,
        note: r.note,
        engineVersion: r.engine_version,
        artistName: input?.artistName ?? null,
        albumTitle: input?.albumTitle ?? null,
      };
    });
}

/** One full record by id — fetched when the queue opens the grading sheet, which
 *  needs the scored candidates the summary deliberately omits. */
export function getFeedback(db: Database, id: number): GenerationFeedbackRecord | null {
  const row = db
    .query<FeedbackRow, [number]>(
      `SELECT id, at, user_id, username, resource_type, resource_ref, verdict, note,
              input_json, output_json, item_flags_json, engine_version
         FROM generation_feedback WHERE id = ?`,
    )
    .get(id);
  return row ? toRecord(row) : null;
}
