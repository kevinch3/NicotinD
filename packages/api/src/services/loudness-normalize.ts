import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';
import { gainForTarget, readOutputGain, writeOutputGain } from './opus-gain.js';

const log = createLogger('loudness-normalize');

/**
 * Bring the library's Opus files to one loudness by writing each file's Opus
 * header gain. Issue #723.
 *
 * The mechanism and its risks live in `opus-gain.ts`; this is the pass that
 * applies it. Two things make it cheap in a way a `loudnorm` re-encode would
 * not be: the audio is never decoded, so a whole-library run is IO-bound
 * rather than CPU-bound, and every file is recoverable by writing `0` back.
 *
 * **It is idempotent by measurement, not by flag.** Each file's current header
 * gain is read and compared to what it should be, so a re-run touches nothing
 * and an interrupted run resumes correctly without any resume bookkeeping. The
 * comparison has a tolerance: the header stores Q7.8 dB, so a gain that
 * round-trips to within half a step is already correct and rewriting it would
 * be churn.
 *
 * **It declines more than it acts on, deliberately.** A file with no loudness
 * reading is skipped rather than normalized to a guess. `library_songs.loudness`
 * had 100% coverage when measured, so the skip count is also a useful signal:
 * a non-zero one means the analysis has fallen behind.
 */

/** Chosen target. Re-tunable at any time — the audio is never touched. */
export const DEFAULT_TARGET_LUFS = -14;

/**
 * Half a Q7.8 step. Below this the stored value would not change, so a write
 * would be pure churn on a library-sized run.
 */
const GAIN_EPSILON_DB = 1 / 512;

/**
 * Files handled between yields. Small enough that a cancel or a health check
 * lands promptly, large enough that the yield itself is not the cost.
 */
const YIELD_EVERY = 64;

export interface NormalizeLoudnessResult {
  /** Files this pass looked at — the denominator, fixed before any work. */
  candidates: number;
  /** Files whose header gain was written. */
  normalized: number;
  /** Already at the right gain; a re-run makes this the whole set. */
  alreadyCorrect: number;
  /** No usable loudness reading, so left alone rather than guessed at. */
  noMeasurement: number;
  /** Missing on disk, unreadable, or not actually Ogg-Opus. */
  failed: number;
  errorSample: string | null;
  /** True when work may remain — cancelled, or the limit filled a full page. */
  stopped: boolean;
  /** Last visited song id; feed back as `afterId` to continue. */
  cursor: string | null;
}

export interface NormalizeLoudnessOptions {
  apply: boolean;
  /** LUFS to normalize to. Defaults to {@link DEFAULT_TARGET_LUFS}. */
  targetLufs?: number;
  /** Max files to visit. Omitted/<=0 → unbounded. */
  limit?: number;
  /** Resume cursor: only consider song ids strictly greater than this. */
  afterId?: string | null;
  shouldStop?: () => boolean;
  onProgress?: (p: { total: number; visited: number; label: string }) => void;
}

interface Row {
  id: string;
  path: string;
  loudness: number | null;
}

export async function normalizeLibraryLoudness(
  db: Database,
  musicDir: string,
  opts: NormalizeLoudnessOptions,
): Promise<NormalizeLoudnessResult> {
  const result: NormalizeLoudnessResult = {
    candidates: 0,
    normalized: 0,
    alreadyCorrect: 0,
    noMeasurement: 0,
    failed: 0,
    errorSample: null,
    stopped: false,
    cursor: null,
  };

  const target = opts.targetLufs ?? DEFAULT_TARGET_LUFS;
  const limit = opts.limit != null && opts.limit > 0 ? opts.limit : -1;
  const afterId = opts.afterId ?? null;

  // `ORDER BY id` is load-bearing: without a stable order a bounded pass
  // re-walks an arbitrary head on every call and never finishes.
  const rows = db
    .query<Row, [string | null, string | null, number]>(
      `SELECT id, path, loudness
         FROM library_songs
        WHERE hidden = 0
          AND lower(suffix) = 'opus'
          AND (? IS NULL OR id > ?)
        ORDER BY id
        LIMIT ?`,
    )
    .all(afterId, afterId, limit);
  result.candidates = rows.length;

  let visited = 0;
  for (const row of rows) {
    // Yield periodically. Every step below is synchronous, so without this the
    // whole pass runs in one turn of the event loop: on prod that starved the
    // health check and the container was marked unhealthy mid-run. Cancelling
    // was impossible for the same reason — `shouldStop` cannot be set by a
    // request that never gets to run.
    if (visited > 0 && visited % YIELD_EVERY === 0) await new Promise(setImmediate);
    if (opts.shouldStop?.()) {
      result.stopped = true;
      break;
    }
    visited += 1;
    result.cursor = row.id;
    opts.onProgress?.({ total: rows.length, visited, label: row.path });

    const wanted = gainForTarget(row.loudness, target);
    if (wanted === null) {
      // No usable measurement. Normalizing to a guess would be a confident
      // wrong answer, and a normalized-to-nothing track is worse than an
      // unnormalized one.
      result.noMeasurement += 1;
      continue;
    }

    const abs = join(musicDir, row.path);
    if (!existsSync(abs)) {
      result.failed += 1;
      result.errorSample ??= `missing on disk: ${row.path}`;
      continue;
    }

    const current = readOutputGain(abs);
    if (current === null) {
      // A `.opus` row whose file is not actually Ogg-Opus. Skip it rather than
      // write into a container this does not understand.
      result.failed += 1;
      result.errorSample ??= `not Ogg-Opus: ${row.path}`;
      continue;
    }
    if (Math.abs(current - wanted) < GAIN_EPSILON_DB) {
      result.alreadyCorrect += 1;
      continue;
    }

    if (!opts.apply) {
      result.normalized += 1; // dry run: report what would be written
      continue;
    }
    if (!writeOutputGain(abs, wanted)) {
      result.failed += 1;
      result.errorSample ??= `could not write gain: ${row.path}`;
      continue;
    }
    result.normalized += 1;
  }
  if (limit > 0 && rows.length === limit) result.stopped = true;

  log.info({ ...result, target, apply: opts.apply }, 'loudness normalize pass complete');
  return result;
}
