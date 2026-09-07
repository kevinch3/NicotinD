/**
 * Per-listener recommendation feedback and the exclusion set it produces.
 *
 * Two ways a track leaves a listener's feeds:
 *
 * - **Explicit** — "Don't recommend this" writes `exclude`; "Recommend again"
 *   writes `restore`. The latest of the two wins, so the log is append-only
 *   and the excluded list is always reconstructible.
 * - **Derived** — repeated early skips. `SKIP_RULE` below is the whole
 *   definition: at least `minSkips` `skipped` play events under `maxMsPlayed`
 *   within `windowMs`, with no counted play *after* the last of them (a full
 *   listen means the listener changed their mind) and no explicit `restore`
 *   after them. Derived skips ride `play_events`, which is consent-gated, so a
 *   listener with history off gets no derived exclusions — only explicit ones.
 *
 * Exclusion is applied by the feeds at request time as a song-id set fed into
 * the same `excludeIds` layer the client's queue uses (radio then widens it to
 * every copy of the recording, issue #660). It is deliberately not a column on
 * `library_songs`: the library is shared, the rejection is one person's.
 */
import type { Database } from 'bun:sqlite';

export const FEEDBACK_KINDS = [
  'exclude',
  'restore',
  'too_similar',
  'balanced',
  'too_different',
] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const SKIP_RULE = {
  /** Skips needed before a track is held out. */
  minSkips: 2,
  /** A skip counts only when this little of the track was heard (20 s). */
  maxMsPlayed: 20_000,
  /** Skips older than this are forgotten (30 days). */
  windowMs: 30 * 24 * 3_600_000,
} as const;

export interface FeedbackInput {
  userId: string;
  songId: string;
  kind: FeedbackKind;
  context?: Record<string, unknown>;
  now?: number;
}

export function recordFeedback(db: Database, input: FeedbackInput): { id: number } {
  const at = input.now ?? Date.now();
  db.run(
    `INSERT INTO recommendation_feedback (user_id, song_id, kind, at, context_json)
     VALUES (?, ?, ?, ?, ?)`,
    [
      input.userId,
      input.songId,
      input.kind,
      at,
      input.context ? JSON.stringify(input.context) : null,
    ],
  );
  const row = db.query<{ id: number }, []>('SELECT last_insert_rowid() AS id').get();
  return { id: row?.id ?? 0 };
}

interface DecisionRow {
  song_id: string;
  kind: string;
  at: number;
}

/** Latest explicit exclude/restore per song, newest first per song. */
function latestExplicit(db: Database, userId: string): Map<string, DecisionRow> {
  const rows = db
    .query<DecisionRow, [string]>(
      `SELECT song_id, kind, MAX(at) AS at FROM recommendation_feedback
       WHERE user_id = ? AND kind IN ('exclude', 'restore')
       GROUP BY song_id`,
    )
    .all(userId);
  // MAX(at) with a bare `kind` is SQLite's bare-column rule: it returns the
  // kind from the row that carried the max. Re-read explicitly to be safe.
  const out = new Map<string, DecisionRow>();
  for (const r of rows) {
    const exact = db
      .query<DecisionRow, [string, string, number]>(
        `SELECT song_id, kind, at FROM recommendation_feedback
         WHERE user_id = ? AND song_id = ? AND at = ? AND kind IN ('exclude', 'restore')
         ORDER BY id DESC LIMIT 1`,
      )
      .get(userId, r.song_id, r.at);
    if (exact) out.set(r.song_id, exact);
  }
  return out;
}

interface DerivedRow {
  song_id: string;
  skips: number;
  last_skip: number;
}

/** Songs whose recent early-skip count meets the rule, with the last skip time. */
function derivedSkips(db: Database, userId: string, now: number): DerivedRow[] {
  return db
    .query<DerivedRow, [string, number, number, number, string]>(
      `WITH early AS (
         SELECT song_id, COUNT(*) AS skips, MAX(at) AS last_skip
         FROM play_events
         WHERE user_id = ? AND reason = 'skipped' AND ms_played < ? AND at > ?
         GROUP BY song_id
         HAVING COUNT(*) >= ?
       )
       SELECT e.song_id, e.skips, e.last_skip FROM early e
       WHERE NOT EXISTS (
         SELECT 1 FROM play_events c
         WHERE c.user_id = ? AND c.song_id = e.song_id AND c.counted = 1 AND c.at > e.last_skip)`,
    )
    .all(userId, SKIP_RULE.maxMsPlayed, now - SKIP_RULE.windowMs, SKIP_RULE.minSkips, userId);
}

export type ExclusionReason = 'explicit' | 'skips';

export interface ExcludedSong {
  songId: string;
  reason: ExclusionReason;
  /** When the exclusion took effect: the explicit vote, or the last skip. */
  since: number;
  /** Skip count behind a derived exclusion. */
  skips?: number;
}

/** Every song this listener should not be recommended right now, with why. */
export function excludedSongs(db: Database, userId: string, now = Date.now()): ExcludedSong[] {
  const explicit = latestExplicit(db, userId);
  const out = new Map<string, ExcludedSong>();
  for (const [songId, d] of explicit) {
    if (d.kind === 'exclude') out.set(songId, { songId, reason: 'explicit', since: d.at });
  }
  for (const d of derivedSkips(db, userId, now)) {
    if (out.has(d.song_id)) continue;
    // An explicit restore after the last skip beats the derived rule.
    const decision = explicit.get(d.song_id);
    if (decision?.kind === 'restore' && decision.at >= d.last_skip) continue;
    out.set(d.song_id, { songId: d.song_id, reason: 'skips', since: d.last_skip, skips: d.skips });
  }
  return [...out.values()].sort((a, b) => b.since - a.since);
}

/** The exclusion set alone — what the feeds splice into `excludeIds`. */
export function excludedSongIds(db: Database, userId: string, now = Date.now()): Set<string> {
  return new Set(excludedSongs(db, userId, now).map((e) => e.songId));
}
