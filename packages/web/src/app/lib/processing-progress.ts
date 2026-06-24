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
