import { describe, expect, it } from 'vitest';
import { moveInList } from './move-in-list';

describe('moveInList', () => {
  it('moves an item forward and backward without losing entries', () => {
    expect(moveInList(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveInList(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
  });

  it('is a no-op for the same index', () => {
    expect(moveInList(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
  });

  it('returns the list unchanged for out-of-range indices', () => {
    expect(moveInList(['a', 'b'], -1, 0)).toEqual(['a', 'b']);
    expect(moveInList(['a', 'b'], 0, 5)).toEqual(['a', 'b']);
  });

  it('never mutates the input', () => {
    const input = ['a', 'b', 'c'];
    moveInList(input, 0, 2);
    expect(input).toEqual(['a', 'b', 'c']);
  });
});
