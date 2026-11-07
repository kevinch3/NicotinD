import { describe, it, expect } from 'vitest';
import { sharePercents } from './share-percents';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('sharePercents (#1670)', () => {
  it('gives the leftover point to the earliest of equal remainders', () => {
    expect(sharePercents([1, 1, 1])).toEqual([34, 33, 33]);
  });

  it('rounds by largest remainder', () => {
    expect(sharePercents([6, 3, 2, 1])).toEqual([50, 25, 17, 8]);
  });

  it('always sums to exactly 100 for a non-empty total', () => {
    for (const counts of [
      [1, 2],
      [7, 7, 7, 7, 7, 7, 7],
      [212, 98, 41, 17, 3, 1],
      [1, 1, 1, 1, 1, 1],
      [999, 1],
    ]) {
      expect(sum(sharePercents(counts))).toBe(100);
    }
  });

  it('keeps an all-zero input at zero', () => {
    expect(sharePercents([0, 0])).toEqual([0, 0]);
    expect(sharePercents([])).toEqual([]);
  });

  it('gives a single bucket the whole', () => {
    expect(sharePercents([5])).toEqual([100]);
  });
});
