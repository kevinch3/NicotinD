import type { ProcessingStatus, ProcessingPhase } from '../../types/core';

/**
 * Pure presentation helpers for the library-processing panel. DI-free so they're
 * unit-testable without rendering (the JIT vitest harness can't drive input()).
 */

/** Percent complete for the progress bar (0–100), clamped. */
export function progressPercent(status: Pick<ProcessingStatus, 'processed' | 'total'>): number {
  const denom = status.processed + status.total;
  if (denom <= 0) return status.processed > 0 ? 100 : 0;
  return Math.min(100, Math.round((status.processed / denom) * 100));
}

/** Short human label for the current phase. */
export function phaseLabel(phase: ProcessingPhase): string {
  switch (phase) {
    case 'running':
      return 'Processing…';
    case 'outside-window':
      return 'Waiting for window';
    case 'disabled':
      return 'Disabled';
    case 'idle':
    default:
      return 'Idle';
  }
}

/** Total remaining items across all tasks. */
export function totalPending(status: Pick<ProcessingStatus, 'taskPending'>): number {
  return Object.values(status.taskPending).reduce((a, b) => a + b, 0);
}

/** True when the processor has nothing left to do. */
export function isComplete(status: Pick<ProcessingStatus, 'taskPending'>): boolean {
  return totalPending(status) === 0;
}

/** True while a run is actively working (drives the disabled "Run now" button). */
export function isRunning(status: Pick<ProcessingStatus, 'phase'>): boolean {
  return status.phase === 'running';
}

/**
 * Toast message for a settled run, or null when there's nothing worth surfacing.
 * A run with failures is an error; an all-clear run that enriched something is a
 * success; a no-op run (nothing pending) returns null (the "started" toast said
 * enough).
 */
export function runOutcomeToast(
  status: Pick<ProcessingStatus, 'processed' | 'failed' | 'lastError'>,
): { kind: 'success' | 'error'; message: string } | null {
  if (status.failed > 0) {
    const reason = status.lastError ? ` — ${status.lastError}` : '';
    const noneOk =
      status.processed === 0
        ? 'Processing failed: '
        : `Processing finished with ${status.failed} failure(s): `;
    return {
      kind: 'error',
      message: `${noneOk}${status.failed} item(s) could not be processed${reason}`,
    };
  }
  if (status.processed > 0) {
    return { kind: 'success', message: `Processing complete — ${status.processed} enriched` };
  }
  return null;
}
