import type { Database } from 'bun:sqlite';
import type { AcquisitionMethod, SongAcquisition } from '@nicotind/core';

/**
 * Acquisition provenance store (the `acquisitions` table).
 *
 * Records HOW (method), WHERE-FROM (source_ref: slskd peer or acquire URL), and
 * WHEN each file was acquired, keyed on its final on-disk `relative_path` — the
 * same join `library_songs.path` already uses. Written at download time by the
 * watchers and best-effort backfilled for pre-existing rows. Same side-table
 * pattern as `release-meta-store.ts` / `artwork-store.ts`: survives full rescans.
 */

const VALID_METHODS: ReadonlySet<string> = new Set([
  'slskd',
  'ytdlp',
  'spotdl',
  'archive',
  'unknown',
]);

export interface RecordAcquisitionInput {
  relativePath: string;
  method: AcquisitionMethod;
  sourceRef?: string | null;
  /** Defaults to 'done'. */
  stage?: string;
  startedAt: number;
  completedAt?: number | null;
  error?: string | null;
}

/**
 * Upsert an acquisition row. INSERT OR REPLACE so a re-download (or backfill that
 * later loses to a real write) keeps the latest provenance for a path. Failures
 * are swallowed — provenance is best-effort and must never break the pipeline.
 */
export function recordAcquisition(db: Database, input: RecordAcquisitionInput): void {
  try {
    db.run(
      `INSERT OR REPLACE INTO acquisitions
        (relative_path, method, source_ref, stage, started_at, completed_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.relativePath,
        input.method,
        input.sourceRef ?? null,
        input.stage ?? 'done',
        input.startedAt,
        input.completedAt ?? null,
        input.error ?? null,
      ],
    );
  } catch {
    // Non-fatal: DB may not be ready or the write may race a rescan.
  }
}

/** Insert an acquisition row only if the path isn't already recorded (backfill). */
export function recordAcquisitionIfMissing(db: Database, input: RecordAcquisitionInput): void {
  try {
    db.run(
      `INSERT OR IGNORE INTO acquisitions
        (relative_path, method, source_ref, stage, started_at, completed_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.relativePath,
        input.method,
        input.sourceRef ?? null,
        input.stage ?? 'done',
        input.startedAt,
        input.completedAt ?? null,
        input.error ?? null,
      ],
    );
  } catch {
    // Non-fatal.
  }
}

interface AcquisitionRow {
  relative_path: string;
  method: string;
  source_ref: string | null;
  completed_at: number | null;
}

/** Read acquisition provenance for a final on-disk path, or null if unrecorded. */
export function getAcquisitionByPath(db: Database, relativePath: string): SongAcquisition | null {
  const row = db
    .query<
      AcquisitionRow,
      [string]
    >('SELECT relative_path, method, source_ref, completed_at FROM acquisitions WHERE relative_path = ?')
    .get(relativePath);
  if (!row) return null;
  return {
    method: (VALID_METHODS.has(row.method) ? row.method : 'unknown') as AcquisitionMethod,
    sourceRef: row.source_ref,
    acquiredAt: row.completed_at,
    storagePath: row.relative_path,
  };
}
