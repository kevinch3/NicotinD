import type { Database } from 'bun:sqlite';
import type { ProcessingTaskId } from '@nicotind/core';

/**
 * Per-(song, task) analysis failure ledger. An ffmpeg *decode* that hard-fails on
 * a specific file (e.g. a corrupt "Invalid data" mp3) is recorded here. Once a
 * file reaches {@link MAX_ANALYSIS_ATTEMPTS} failures for a task the windowed
 * processor excludes it from that task's pending set, so a permanently-broken
 * file stops being retried — and re-alerting Sentry — on every run.
 *
 * Reset is automatic and content-based: `file_size` records the size at the last
 * failure, so a re-download (which changes the size) clears the skip and lets the
 * repaired file be retried. A *successful* analysis clears the row outright.
 *
 * Scope is the provenance-aware tasks:
 *  - `bpm`, `key`, `energy`: ffmpeg *decode* failures reliably mean the *file*
 *    is bad (corrupt / truncated) — ledgered + tallied as run failures.
 *  - `audio-features`: a sidecar **422** (the sidecar reached + tried to decode
 *    the file but the bytes are unusable) is ledgered, since it's a per-file
 *    condition mirroring the corrupt-file handling of the decode tasks. A 404
 *    (file not visible to the sidecar, usually a mount mismatch that 404s *every*
 *    file) is NOT ledgered: that's environmental, and permanently skipping on it
 *    would leave the whole library excluded even after the sidecar is fixed.
 *  - `genre`: a song whose artist Lidarr can't resolve is ledgered (so it stops
 *    being re-queried every batch) but NOT tallied as a failure — nothing is
 *    broken, Lidarr simply has no genre. A re-tag/re-download re-includes it.
 *
 * It is NOT used for `artist-image` (per-artist; failures there are metadata
 * service issues, not audio-file problems).
 */

/** Failures at or above this count exclude the file from the task's pending set. */
export const MAX_ANALYSIS_ATTEMPTS = 3;

const MAX_ERROR_LEN = 500;

/**
 * Record one hard failure for (song, task). If the file's size changed since the
 * last recorded failure (a re-download / repair), the counter resets to 1 rather
 * than continuing to climb — the new bytes deserve a fresh set of attempts.
 *
 * `terminal` marks a *confident negative* — the source answered "no such data
 * exists for this recording" — as opposed to an attempt that failed. It settles
 * the task on the first answer instead of after {@link MAX_ANALYSIS_ATTEMPTS},
 * and is deliberately not size-guarded: the answer is a property of the
 * recording, not of the bytes, and size-guarding it is what stranded 261 songs
 * behind a landing gate (issue #689 / #687). `clearAnalysisFailure` on a later
 * success remains the way back.
 */
export function recordAnalysisFailure(
  db: Database,
  songId: string,
  task: ProcessingTaskId,
  error: unknown,
  fileSize: number | null,
  terminal = false,
): void {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LEN);
  const now = Date.now();
  const existing = db
    .query<{ fail_count: number; file_size: number | null }, [string, string]>(
      'SELECT fail_count, file_size FROM library_song_analysis_failures WHERE song_id = ? AND task = ?',
    )
    .get(songId, task);
  const sameFile = existing != null && existing.file_size === fileSize;
  const nextCount = sameFile ? existing!.fail_count + 1 : 1;
  const flag = terminal ? 1 : 0;
  db.run(
    `INSERT INTO library_song_analysis_failures (song_id, task, fail_count, last_error, file_size, last_attempt, terminal)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(song_id, task) DO UPDATE SET
       fail_count = ?, last_error = ?, file_size = ?, last_attempt = ?, terminal = ?`,
    [
      songId,
      task,
      nextCount,
      message,
      fileSize,
      now,
      flag,
      nextCount,
      message,
      fileSize,
      now,
      flag,
    ],
  );
}

/**
 * Re-anchor a song's file-size bookkeeping after **we** rewrote its file.
 *
 * The size comparison in {@link permanentlyFailedClause} exists to give genuinely
 * new bytes (a re-download, a user re-tag) a fresh set of attempts. But enrichment
 * writes its own results — BPM, KEY, ENERGY, MOOD — back into the same file, which
 * moves the size by a couple of hundred bytes and makes our own write look like a
 * replacement: the ledger row goes stale, `recordAnalysisFailure` resets the count
 * to 1, and the file can never reach the cap. On prod that livelocked 62 songs and
 * half-landed whole albums (issue #690 / #687).
 *
 * So the writer tells the ledger. Both `library_songs.size` and every ledger row
 * for the song move to the post-write size together, leaving a *genuine* outside
 * change — which nothing rebases — as the only thing that still resets a counter.
 */
export function rebaseAnalysisFileSize(db: Database, songId: string, newSize: number): void {
  db.run('UPDATE library_songs SET size = ? WHERE id = ?', [newSize, songId]);
  db.run('UPDATE library_song_analysis_failures SET file_size = ? WHERE song_id = ?', [
    newSize,
    songId,
  ]);
}

/** Clear any failure record for (song, task) — a success, or a repaired file. */
export function clearAnalysisFailure(db: Database, songId: string, task: ProcessingTaskId): void {
  db.run('DELETE FROM library_song_analysis_failures WHERE song_id = ? AND task = ?', [
    songId,
    task,
  ]);
}

/**
 * A correlated `AND NOT EXISTS (...)` clause that excludes songs which have hit
 * the attempt cap for `task` *and* whose file is unchanged since (size match, so
 * a re-download re-includes them). Returns a bare SQL fragment with no bind
 * params — `task` and the threshold are internal constants, safe to inline —
 * so it drops into an existing `WHERE ... LIMIT ?` without disturbing params.
 * `s` is the alias/name of the library_songs row in the outer query.
 */
export function notPermanentlyFailedClause(task: ProcessingTaskId, s = 'library_songs'): string {
  return (
    ` AND NOT EXISTS (SELECT 1 FROM library_song_analysis_failures f` +
    ` WHERE f.song_id = ${s}.id AND f.task = '${task}'` +
    ` AND (f.terminal = 1` +
    ` OR (f.fail_count >= ${MAX_ANALYSIS_ATTEMPTS} AND f.file_size IS ${s}.size)))`
  );
}

/**
 * The positive complement of {@link notPermanentlyFailedClause}: a correlated
 * `EXISTS (...)` fragment (leading ` AND ` intentionally omitted so callers can
 * compose it into an `OR`) that is true when `task` has hit the attempt cap for a
 * still-unchanged file. Used by the landing-gate graduation predicate to express
 * "this required step succeeded, OR it's permanently failed for this file" — so a
 * corrupt file the enrichment can never analyze still eventually lands. Same
 * no-bind-param, inline-constant contract as `notPermanentlyFailedClause`.
 */
export function permanentlyFailedClause(task: ProcessingTaskId, s = 'library_songs'): string {
  return (
    `EXISTS (SELECT 1 FROM library_song_analysis_failures f` +
    ` WHERE f.song_id = ${s}.id AND f.task = '${task}'` +
    ` AND (f.terminal = 1` +
    ` OR (f.fail_count >= ${MAX_ANALYSIS_ATTEMPTS} AND f.file_size IS ${s}.size)))`
  );
}

/**
 * Count of distinct files currently excluded (any task at the attempt cap).
 *
 * Deliberately counts only the attempt cap, never `terminal` rows: this number is
 * reported as broken/undetectable files, and a confident negative means the file is
 * fine — the data simply doesn't exist. Counting those would report most of the
 * library as broken the moment a "no such data" source is enabled (issue #689).
 */
export function countSkippedFiles(db: Database): number {
  const row = db
    .query<{ n: number }, []>(
      `SELECT COUNT(DISTINCT song_id) AS n FROM library_song_analysis_failures
       WHERE fail_count >= ${MAX_ANALYSIS_ATTEMPTS}`,
    )
    .get();
  return Number(row?.n ?? 0);
}
