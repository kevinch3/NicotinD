import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';

const log = createLogger('acquisition-attempts');

/** Attempts older than this are pruned with the job hygiene pass (#1626). */
export const ATTEMPT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface AttemptRecord {
  kind: 'hunt' | 'enqueue';
  lane?: string;
  attemptId?: string;
  addonUrl?: string;
  lidarrAlbumId?: number;
  artist?: string;
  album?: string;
  /** One token: a hunt's `huntOutcome`, `timeout`/`error`, or an enqueue's `created`/`conflict`/`error`. */
  outcome: string;
  detail?: string;
  durationMs?: number;
  queuedMs?: number;
  candidates?: number;
  searchesFired?: number;
  searchesAnswered?: number;
}

export type AttemptRecorder = (record: AttemptRecord) => void;

let recorder: AttemptRecorder | null = null;

/**
 * The addon client reports every hunt and enqueue here. Boot wires it to the
 * ledger once; tests and embedded callers leave it unset, which records nothing.
 */
export function setAttemptRecorder(next: AttemptRecorder | null): void {
  recorder = next;
}

/** Never throws: a ledger write must not fail the acquisition it describes. */
export function reportAttempt(record: AttemptRecord): void {
  if (!recorder) return;
  try {
    recorder(record);
  } catch (err) {
    log.warn({ err, kind: record.kind, outcome: record.outcome }, 'attempt ledger write failed');
  }
}

export function recordAttempt(db: Database, r: AttemptRecord, now = Date.now()): void {
  db.run(
    `INSERT INTO acquisition_attempts
       (at, kind, lane, attempt_id, addon_url, lidarr_album_id, artist, album, outcome, detail,
        duration_ms, queued_ms, candidates, searches_fired, searches_answered)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      now,
      r.kind,
      r.lane ?? null,
      r.attemptId ?? null,
      r.addonUrl ?? null,
      r.lidarrAlbumId ?? null,
      r.artist ?? null,
      r.album ?? null,
      r.outcome,
      r.detail?.slice(0, 500) ?? null,
      r.durationMs ?? null,
      r.queuedMs ?? null,
      r.candidates ?? null,
      r.searchesFired ?? null,
      r.searchesAnswered ?? null,
    ],
  );
}

export function pruneAttempts(db: Database, now = Date.now()): number {
  const res = db.run(`DELETE FROM acquisition_attempts WHERE at < ?`, [now - ATTEMPT_RETENTION_MS]);
  return Number(res.changes ?? 0);
}
