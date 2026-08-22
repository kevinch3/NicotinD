import type { MaintenanceStatus } from '../services/api/api-types';

/**
 * Pure presentation helpers for the maintenance panel (issue #622). DI-free so
 * they're unit-testable without rendering.
 *
 * Deliberately NOT reusing `processing-progress.ts`'s `progressPercent`: there
 * `total` means work *remaining* (`denom = processed + total`), here it is the
 * denominator itself. Passing this shape to that function silently computes the
 * wrong bar rather than failing.
 */

/** Percent complete (0–100), clamped. 0 when the pass can't count ahead. */
export function maintenanceProgressPercent(
  status: Pick<MaintenanceStatus, 'visited' | 'total'>,
): number {
  if (status.total <= 0) return 0;
  return Math.min(100, Math.round((status.visited / status.total) * 100));
}

/** A pass is in flight — `cancelling` still counts, the work hasn't stopped yet. */
export function isMaintenanceRunning(status: MaintenanceStatus | null): boolean {
  return status?.phase === 'running' || status?.phase === 'cancelling';
}

/** True when this specific task is the one running. */
export function isTaskRunning(
  status: MaintenanceStatus | null,
  taskId: MaintenanceStatus['taskId'],
): boolean {
  return isMaintenanceRunning(status) && status?.taskId === taskId;
}

/**
 * i18n key + params describing how the last pass ended, or null when none has.
 * `cancelled` is a distinct non-error state, which is why this can't reuse the
 * processing panel's `runOutcomeToast`.
 */
export function maintenanceOutcome(
  status: MaintenanceStatus | null,
): { key: string; params: Record<string, string | number> } | null {
  if (!status || isMaintenanceRunning(status) || !status.lastOutcome) return null;
  const params: Record<string, string | number> = {
    visited: status.visited,
    total: status.total,
    error: status.lastError ?? '',
  };
  switch (status.lastOutcome) {
    case 'cancelled':
      return { key: 'admin.maintenanceCancelled', params };
    case 'failed':
      return { key: 'admin.maintenanceFailed', params };
    default:
      return {
        key: status.dryRun ? 'admin.maintenanceDoneDryRun' : 'admin.maintenanceDone',
        params,
      };
  }
}

/** Counter pairs for the generic detail line, in the task's own key order. */
export function detailPairs(status: MaintenanceStatus | null): Array<[string, number]> {
  return Object.entries(status?.detail ?? {});
}
