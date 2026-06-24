import { describe, expect, it } from 'vitest';
import { progressPercent, phaseLabel, totalPending, isComplete } from './processing-progress';

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
    expect(totalPending({ taskPending: { bpm: 4, genre: 2 } })).toBe(6);
  });

  it('isComplete when all task counts are zero', () => {
    expect(isComplete({ taskPending: { bpm: 0, genre: 0 } })).toBe(true);
    expect(isComplete({ taskPending: { bpm: 1, genre: 0 } })).toBe(false);
  });
});
