import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';
import { inFlightRequests } from '../middleware/in-flight.js';
import { startLoopBlockMonitor, type LoopBlock } from './loop-block-monitor.js';

const log = createLogger('loop-block');

/** Long enough to span several deploys and a quarterly re-measure (#1058). */
export const LOOP_BLOCK_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** Bounds a pathological storm (≤1 row/s) to ~1 MB; a healthy quarter is a few dozen rows. */
export const LOOP_BLOCK_MAX_ROWS = 10_000;
/** `library_sync_state` key: when this database first had a recorder, so zero rows reads as "none since". */
export const LOOP_BLOCKS_SINCE_KEY = 'loop_blocks_recording_since';

/**
 * Persist one block and prune, in the same breath. Both deletes are index
 * range scans (`at`, then the rowid) that almost always match nothing, so the
 * write costs one small WAL append right after the loop was already stalled.
 * Never throws: losing a diagnostic row must not take down the process.
 */
export function recordLoopBlock(db: Database, block: LoopBlock, now = Date.now()): void {
  try {
    db.run('INSERT INTO loop_blocks (at, blocked_ms, in_flight) VALUES (?, ?, ?)', [
      now,
      block.blockedMs,
      JSON.stringify(block.inFlight),
    ]);
    db.run('DELETE FROM loop_blocks WHERE at < ?', [now - LOOP_BLOCK_RETENTION_MS]);
    db.run('DELETE FROM loop_blocks WHERE id <= (SELECT MAX(id) FROM loop_blocks) - ?', [
      LOOP_BLOCK_MAX_ROWS,
    ]);
  } catch (err) {
    log.error({ err }, 'loop block write failed');
  }
}

/** The monitor as createApp runs it: attributed by `trackInFlight`, persisted to `loop_blocks`. */
export function startLoopBlockRecorder(
  db: Database,
  tuning: { intervalMs?: number; budgetMs?: number } = {},
): () => void {
  db.run('INSERT OR IGNORE INTO library_sync_state (key, value, updated_at) VALUES (?, ?, ?)', [
    LOOP_BLOCKS_SINCE_KEY,
    String(Date.now()),
    Date.now(),
  ]);
  return startLoopBlockMonitor({
    inFlight: inFlightRequests,
    onBlock: (block) => recordLoopBlock(db, block),
    ...tuning,
  });
}

/** How far back `/api/health/signals` reports blocks: the droplet probe's alert window. */
export const LOOP_BLOCK_SIGNAL_WINDOW_MS = 15 * 60 * 1000;
/** A storm is already an alert well before this many; the cap keeps the probe's payload small. */
const LOOP_BLOCK_SIGNAL_MAX = 200;

/**
 * Durations of the blocks recorded in the last `windowMs`, most recent first —
 * the raw material the droplet probe applies its paging policy to
 * (docs/host-monitoring.md). Only durations: the endpoint is public, request
 * paths are not. Never throws: a failed read is `null` — "unknown", which the
 * probe must not mistake for "no blocks".
 */
export function recentLoopBlockDurations(
  db: Database,
  windowMs = LOOP_BLOCK_SIGNAL_WINDOW_MS,
  now = Date.now(),
): number[] | null {
  try {
    return db
      .query<{ blocked_ms: number }, [number, number]>(
        'SELECT blocked_ms FROM loop_blocks WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?',
      )
      .all(now - windowMs, LOOP_BLOCK_SIGNAL_MAX)
      .map((r) => r.blocked_ms);
  } catch (err) {
    log.error({ err }, 'loop block read failed');
    return null;
  }
}
