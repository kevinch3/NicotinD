import { describe, it, expect } from 'vitest';
import { seekFraction, seekTime } from './seek-utils';

describe('seekFraction', () => {
  it('maps a click at the start of the bar to 0', () => {
    expect(seekFraction(100, 100, 200)).toBe(0);
  });

  it('maps a click at the middle of the bar to 0.5', () => {
    expect(seekFraction(200, 100, 200)).toBe(0.5);
  });

  it('maps a click at the end of the bar to 1', () => {
    expect(seekFraction(300, 100, 200)).toBe(1);
  });

  it('clamps clicks left of the bar to 0', () => {
    expect(seekFraction(50, 100, 200)).toBe(0);
  });

  it('clamps clicks right of the bar to 1', () => {
    expect(seekFraction(999, 100, 200)).toBe(1);
  });

  it('returns 0 for a zero-width bar (not laid out yet)', () => {
    expect(seekFraction(150, 100, 0)).toBe(0);
  });
});

describe('seekTime', () => {
  it('converts a fraction to seconds', () => {
    expect(seekTime(0.5, 200)).toBe(100);
  });

  it('returns 0 for non-positive or non-finite duration', () => {
    expect(seekTime(0.5, 0)).toBe(0);
    expect(seekTime(0.5, NaN)).toBe(0);
    expect(seekTime(0.5, Infinity)).toBe(0);
  });

  it('clamps out-of-range fractions', () => {
    expect(seekTime(-1, 200)).toBe(0);
    expect(seekTime(2, 200)).toBe(200);
  });
});
