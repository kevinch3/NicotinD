import { describe, expect, it } from 'vitest';
import {
  progressPercent,
  phaseLabel,
  totalPending,
  isComplete,
  isRunning,
  runOutcomeToast,
} from './processing-progress';

describe('progressPercent', () => {
  it('is 0 when nothing processed and nothing pending', () => {
    expect(progressPercent({ processed: 0, total: 0 })).toBe(0);
  });

  it('reflects processed against processed+total remaining', () => {
    // 3 done, 7 still pending → 30%.
    expect(progressPercent({ processed: 3, total: 7 })).toBe(30);
  });

  it('is 100 when all processed and none pending', () => {
    expect(progressPercent({ processed: 10, total: 0 })).toBe(100);
  });

  it('clamps to 100', () => {
    expect(progressPercent({ processed: 50, total: -5 })).toBe(100);
  });
});

describe('phaseLabel', () => {
  it('maps phases to labels', () => {
    expect(phaseLabel('running')).toBe('Processing…');
    expect(phaseLabel('outside-window')).toBe('Waiting for window');
    expect(phaseLabel('disabled')).toBe('Disabled');
    expect(phaseLabel('idle')).toBe('Idle');
  });
});

describe('totalPending / isComplete', () => {
  it('sums per-task pending counts', () => {
    expect(totalPending({ taskPending: { bpm: 4, genre: 2, key: 0, 'artist-image': 0 } })).toBe(6);
  });

  it('isComplete when all task counts are zero', () => {
    expect(isComplete({ taskPending: { bpm: 0, genre: 0, key: 0, 'artist-image': 0 } })).toBe(true);
    expect(isComplete({ taskPending: { bpm: 1, genre: 0, key: 0, 'artist-image': 0 } })).toBe(
      false,
    );
  });
});

describe('isRunning', () => {
  it('is true only for the running phase', () => {
    expect(isRunning({ phase: 'running' })).toBe(true);
    expect(isRunning({ phase: 'idle' })).toBe(false);
    expect(isRunning({ phase: 'disabled' })).toBe(false);
    expect(isRunning({ phase: 'outside-window' })).toBe(false);
  });
});

describe('runOutcomeToast', () => {
  it('is an error toast carrying the reason when items failed', () => {
    const t = runOutcomeToast({ processed: 0, failed: 25, lastError: 'code 183: Invalid data' });
    expect(t?.kind).toBe('error');
    expect(t?.message).toContain('code 183');
  });

  it('reports partial failure when some succeeded and some failed', () => {
    const t = runOutcomeToast({ processed: 10, failed: 3, lastError: null });
    expect(t?.kind).toBe('error');
    expect(t?.message).toContain('3 failure');
  });

  it('is a success toast when everything succeeded', () => {
    const t = runOutcomeToast({ processed: 12, failed: 0, lastError: null });
    expect(t?.kind).toBe('success');
    expect(t?.message).toContain('12');
  });

  it('is null when nothing was processed and nothing failed', () => {
    expect(runOutcomeToast({ processed: 0, failed: 0, lastError: null })).toBeNull();
  });
});
