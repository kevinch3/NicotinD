import { computeBufferedSegments, bufferedGradient } from './buffered-ranges';

describe('computeBufferedSegments', () => {
  it('returns [] for zero/unknown duration', () => {
    expect(computeBufferedSegments([{ start: 0, end: 10 }], 0)).toEqual([]);
    expect(computeBufferedSegments([{ start: 0, end: 10 }], NaN)).toEqual([]);
  });

  it('converts ranges to percent segments', () => {
    expect(computeBufferedSegments([{ start: 0, end: 50 }], 200)).toEqual([
      { left: 0, width: 25 },
    ]);
  });

  it('handles multiple ranges and keeps them sorted by start', () => {
    const segs = computeBufferedSegments(
      [
        { start: 150, end: 200 },
        { start: 0, end: 50 },
      ],
      200,
    );
    expect(segs).toEqual([
      { left: 0, width: 25 },
      { left: 75, width: 25 },
    ]);
  });

  it('clamps ranges that exceed the duration', () => {
    expect(computeBufferedSegments([{ start: 100, end: 500 }], 200)).toEqual([
      { left: 50, width: 50 },
    ]);
  });

  it('drops empty, inverted, and sub-0.5% sliver ranges', () => {
    expect(computeBufferedSegments([{ start: 10, end: 10 }], 200)).toEqual([]);
    expect(computeBufferedSegments([{ start: 20, end: 10 }], 200)).toEqual([]);
    // 0.4 of 200s = 0.2% — invisible at seek-bar widths, skip.
    expect(computeBufferedSegments([{ start: 0, end: 0.4 }], 200)).toEqual([]);
  });
});

describe('bufferedGradient', () => {
  it('returns null when there is nothing to paint', () => {
    expect(bufferedGradient([])).toBeNull();
  });

  it('builds a hard-stop gradient painting each segment over the base track color', () => {
    const g = bufferedGradient([{ left: 25, width: 50 }]);
    expect(g).toBe(
      'linear-gradient(to right, ' +
        'var(--theme-surface-2) 25%, var(--seek-buffered-color) 25%, ' +
        'var(--seek-buffered-color) 75%, var(--theme-surface-2) 75%)',
    );
  });

  it('chains stops for multiple segments', () => {
    const g = bufferedGradient([
      { left: 0, width: 10 },
      { left: 50, width: 10 },
    ]);
    expect(g).toContain('var(--seek-buffered-color) 0%');
    expect(g).toContain('var(--theme-surface-2) 10%');
    expect(g).toContain('var(--seek-buffered-color) 50%');
    expect(g).toContain('var(--theme-surface-2) 60%');
  });
});
