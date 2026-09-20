import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';

const log = createLogger('transcode-run-store');

/**
 * A durable record of whole-library transcode passes.
 *
 * **Why this exists, against the case for not having it.** `MaintenanceService`
 * keeps its status in memory on purpose, and its docstring is right about the
 * thing it is arguing against: persisting a *live* `phase: 'running'` leaves a
 * row behind a crash with no process under it, and a stale "running" is worse
 * than no status at all.
 *
 * That argument settles where live status belongs. It does not settle whether a
 * completed pass leaves a trace, and today none does — the maintenance panel's
 * last outcome is wiped by the next task or any restart, so after a 13,864-file
 * irreversible conversion the only durable evidence is one `maintenance.start`
 * audit row saying it began.
 *
 * **A terminal-only record cannot answer the question that matters.** "Did it
 * finish?" is exactly the question an interrupted run fails to answer, because
 * an interrupted run never reaches the code that would write the row. So a row
 * is written at **start**, and {@link reconcileTranscodeRunsOnBoot} sweeps any
 * that outlived their process. That pairing is the whole design — neither half
 * is sound alone, and it is the same bargain `reconcileImportJobsOnBoot`
 * already strikes.
 *
 * Per-file detail deliberately has no table and no log. The quarantine run dir
 * **is** the per-item record: every original the pass replaced is a real file
 * under `<dataDir>/quarantine/<run>/`, at its library-relative path. A parallel
 * TSV would be a second, weaker copy of that — and the one precedent for such a
 * log (`library-processing.log`) grows unbounded with nothing reading it.
 */

/** A run that outlived its process gets this, never a lingering `running`. */
export const INTERRUPTED_ERROR = 'Interrupted by a server restart — counters are as of the crash';

export type TranscodeRunState = 'running' | 'done' | 'failed' | 'interrupted';

/** States a run can still leave. Anything else is finished, for good. */
const NON_TERMINAL: readonly TranscodeRunState[] = ['running'];

export interface TranscodeRun {
  id: string;
  state: TranscodeRunState;
  apply: boolean;
  bitRate: number;
  /** Where the replaced originals were kept, when they were. */
  quarantineRun: string | null;
  candidates: number;
  converted: number;
  skipped: number;
  failed: number;
  bytesReclaimed: number;
  error: string | null;
  startedBy: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface StartTranscodeRunInput {
  apply: boolean;
  bitRate: number;
  startedBy?: string | null;
}

/** Counters as the pass finished, plus why it stopped. */
export interface FinishTranscodeRunInput {
  state: Exclude<TranscodeRunState, 'running'>;
  quarantineRun?: string | null;
  candidates: number;
  converted: number;
  skipped: number;
  failed: number;
  bytesReclaimed: number;
  error?: string | null;
}

/**
 * Open a run row and return its id. Called **before** the first file is
 * touched, so a crash one file in still leaves evidence the pass existed.
 */
export function startTranscodeRun(
  db: Database,
  input: StartTranscodeRunInput,
  now = Date.now(),
): string {
  const id = randomUUID();
  db.run(
    `INSERT INTO transcode_runs (id, state, apply, bit_rate, started_by, started_at)
     VALUES (?, 'running', ?, ?, ?, ?)`,
    [id, input.apply ? 1 : 0, input.bitRate, input.startedBy ?? null, now],
  );
  return id;
}

/** Close a run with its final counters. Idempotent by id. */
export function finishTranscodeRun(
  db: Database,
  id: string,
  input: FinishTranscodeRunInput,
  now = Date.now(),
): void {
  db.run(
    `UPDATE transcode_runs
        SET state = ?, quarantine_run = ?, candidates = ?, converted = ?, skipped = ?,
            failed = ?, bytes_reclaimed = ?, error = ?, finished_at = ?
      WHERE id = ?`,
    [
      input.state,
      input.quarantineRun ?? null,
      input.candidates,
      input.converted,
      input.skipped,
      input.failed,
      input.bytesReclaimed,
      input.error ?? null,
      now,
      id,
    ],
  );
}

/**
 * Flip any run still marked `running` to `interrupted`.
 *
 * Nothing survives a restart mid-pass, so a `running` row at boot is by
 * definition orphaned. Its counters are kept as they were — they are the last
 * thing the pass reported, and a run that converted 4,000 files before dying is
 * a very different situation from one that converted none.
 *
 * Returns the ids it swept, so the caller can log or surface them.
 */
export function reconcileTranscodeRunsOnBoot(db: Database, now = Date.now()): string[] {
  const placeholders = NON_TERMINAL.map(() => '?').join(', ');
  const orphans = db
    .query<{ id: string }, string[]>(
      `SELECT id FROM transcode_runs WHERE state IN (${placeholders})`,
    )
    .all(...NON_TERMINAL);
  for (const o of orphans) {
    db.run(
      `UPDATE transcode_runs SET state = 'interrupted', error = ?, finished_at = ? WHERE id = ?`,
      [INTERRUPTED_ERROR, now, o.id],
    );
  }
  if (orphans.length > 0) {
    log.warn(
      { runs: orphans.map((o) => o.id) },
      'transcode run(s) did not survive a restart — marked interrupted',
    );
  }
  return orphans.map((o) => o.id);
}

/** Most recent first. The list a "what has this thing done to my library" view needs. */
export function listTranscodeRuns(db: Database, limit = 20): TranscodeRun[] {
  return db
    .query<Record<string, unknown>, [number]>(
      `SELECT * FROM transcode_runs ORDER BY started_at DESC LIMIT ?`,
    )
    .all(limit)
    .map(mapRow);
}

export function getTranscodeRun(db: Database, id: string): TranscodeRun | null {
  const row = db
    .query<Record<string, unknown>, [string]>(`SELECT * FROM transcode_runs WHERE id = ?`)
    .get(id);
  return row ? mapRow(row) : null;
}

function mapRow(r: Record<string, unknown>): TranscodeRun {
  return {
    id: String(r.id),
    state: String(r.state) as TranscodeRunState,
    apply: Number(r.apply) === 1,
    bitRate: Number(r.bit_rate),
    quarantineRun: (r.quarantine_run as string | null) ?? null,
    candidates: Number(r.candidates),
    converted: Number(r.converted),
    skipped: Number(r.skipped),
    failed: Number(r.failed),
    bytesReclaimed: Number(r.bytes_reclaimed),
    error: (r.error as string | null) ?? null,
    startedBy: (r.started_by as string | null) ?? null,
    startedAt: Number(r.started_at),
    finishedAt: r.finished_at == null ? null : Number(r.finished_at),
  };
}
