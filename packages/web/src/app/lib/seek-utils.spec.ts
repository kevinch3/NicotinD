import { describe, it, expect } from 'vitest';
import { seekPercent } from './seek-utils';

describe('seekPercent', () => {
  it('maps position to a 0..100 percentage of the duration', () => {
    expect(seekPercent(0, 200)).toBe(0);
    expect(seekPercent(100, 200)).toBe(50);
    expect(seekPercent(200, 200)).toBe(100);
  });

  it('clamps positions beyond the track bounds', () => {
    expect(seekPercent(-50, 200)).toBe(0);
    expect(seekPercent(300, 200)).toBe(100);
  });

  it('returns 0 for an unknown or zero duration', () => {
    expect(seekPercent(100, 0)).toBe(0);
    expect(seekPercent(100, NaN)).toBe(0);
    expect(seekPercent(100, Infinity)).toBe(0);
  });
});
