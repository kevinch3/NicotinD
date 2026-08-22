import { describe, expect, it } from 'vitest';
import {
  detailPairs,
  isMaintenanceRunning,
  isTaskRunning,
  maintenanceOutcome,
  maintenanceProgressPercent,
} from './maintenance-progress';
import type { MaintenanceStatus } from '../services/api/api-types';

function status(over: Partial<MaintenanceStatus> = {}): MaintenanceStatus {
  return {
    phase: 'idle',
    taskId: null,
    label: null,
    total: 0,
    visited: 0,
    lastItems: [],
    detail: {},
    dryRun: false,
    params: null,
    startedAt: null,
    finishedAt: null,
    lastOutcome: null,
    lastError: null,
    startedBy: null,
    ...over,
  };
}

describe('maintenanceProgressPercent', () => {
  it('treats total as the denominator, not the remainder', () => {
    // The processing panel's helper would read this as 3/(3+10) = 23%.
    expect(maintenanceProgressPercent({ visited: 3, total: 10 })).toBe(30);
  });

  it('reports 0 when the pass cannot count ahead', () => {
    expect(maintenanceProgressPercent({ visited: 5, total: 0 })).toBe(0);
  });

  it('clamps above 100', () => {
    expect(maintenanceProgressPercent({ visited: 12, total: 10 })).toBe(100);
  });
});

describe('isMaintenanceRunning', () => {
  it('counts cancelling as still running — the work has not stopped yet', () => {
    expect(isMaintenanceRunning(status({ phase: 'cancelling' }))).toBe(true);
    expect(isMaintenanceRunning(status({ phase: 'running' }))).toBe(true);
    expect(isMaintenanceRunning(status())).toBe(false);
    expect(isMaintenanceRunning(null)).toBe(false);
  });

  it('scopes to one task', () => {
    const s = status({ phase: 'running', taskId: 'metadata-optimize' });
    expect(isTaskRunning(s, 'metadata-optimize')).toBe(true);
    expect(isTaskRunning(s, 'library-sync')).toBe(false);
  });
});

describe('maintenanceOutcome', () => {
  it('is null while running, and before any pass has run', () => {
    expect(maintenanceOutcome(status({ phase: 'running', lastOutcome: 'completed' }))).toBeNull();
    expect(maintenanceOutcome(status())).toBeNull();
    expect(maintenanceOutcome(null)).toBeNull();
  });

  it('distinguishes cancelled from failed', () => {
    expect(maintenanceOutcome(status({ lastOutcome: 'cancelled' }))?.key).toBe(
      'admin.maintenanceCancelled',
    );
    expect(maintenanceOutcome(status({ lastOutcome: 'failed' }))?.key).toBe(
      'admin.maintenanceFailed',
    );
  });

  it('says "would update" for a dry run', () => {
    expect(maintenanceOutcome(status({ lastOutcome: 'completed', dryRun: true }))?.key).toBe(
      'admin.maintenanceDoneDryRun',
    );
    expect(maintenanceOutcome(status({ lastOutcome: 'completed' }))?.key).toBe(
      'admin.maintenanceDone',
    );
  });

  it('carries the counters through as params', () => {
    const o = maintenanceOutcome(status({ lastOutcome: 'completed', visited: 7, total: 9 }));
    expect(o?.params).toMatchObject({ visited: 7, total: 9 });
  });
});

describe('detailPairs', () => {
  it('preserves the task-defined key order and tolerates absence', () => {
    expect(detailPairs(status({ detail: { candidates: 3, matched: 1 } }))).toEqual([
      ['candidates', 3],
      ['matched', 1],
    ]);
    expect(detailPairs(null)).toEqual([]);
  });
});
