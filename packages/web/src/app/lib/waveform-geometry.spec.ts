import { describe, expect, it } from 'vitest';
import { bandLevelsAt, envelopePath, resamplePeaks } from './waveform-geometry';

describe('resamplePeaks', () => {
  it('merges pairs into fewer columns keeping min of mins and max of maxes', () => {
    const pairs = [-0.1, 0.2, -0.5, 0.1, -0.2, 0.9, -0.3, 0.3];
    expect(resamplePeaks(pairs, 2)).toEqual([-0.5, 0.2, -0.3, 0.9]);
  });

  it('repeats pairs when asked for more columns than it has (nearest, never invented)', () => {
    expect(resamplePeaks([-0.5, 0.5, -0.2, 0.2], 4)).toEqual([
      -0.5, 0.5, -0.5, 0.5, -0.2, 0.2, -0.2, 0.2,
    ]);
  });

  it('returns an empty list for no peaks or no columns', () => {
    expect(resamplePeaks([], 10)).toEqual([]);
    expect(resamplePeaks([-1, 1], 0)).toEqual([]);
  });
});

describe('envelopePath', () => {
  const pairs = [-0.5, 0.5, -0.25, 1, 0, 0, -1, 0.1];

  it('is a closed path spanning the full width, maxes on top and mins below the centre', () => {
    const d = envelopePath(pairs, 100, 40);
    expect(d.startsWith('M')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
    const ys = [...d.matchAll(/[ML]\s*[\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(40);
    // Full-scale max (pair 2) reaches the top edge; full-scale min (pair 4) the bottom.
    expect(Math.min(...ys)).toBe(0);
    expect(Math.max(...ys)).toBe(40);
    const xs = [...d.matchAll(/[ML]\s*([\d.]+),/g)].map((m) => Number(m[1]));
    expect(Math.max(...xs)).toBe(100);
  });

  it('keeps a hairline for silence so the strip never vanishes', () => {
    const d = envelopePath([0, 0, 0, 0], 50, 20);
    const ys = [...d.matchAll(/[ML]\s*[\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(3);
  });

  it('returns an empty path for no peaks', () => {
    expect(envelopePath([], 100, 40)).toBe('');
  });
});

describe('bandLevelsAt', () => {
  const bands = [
    [0, 0, 0, 0, 0, 0],
    [1, 0.5, 0, 0, 0, 0],
    [0, 1, 0, 0, 0, 0],
  ];

  it('reads the frame under the playhead and interpolates between frames', () => {
    expect(bandLevelsAt(bands, 4, 0)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(bandLevelsAt(bands, 4, 0.25)).toEqual([1, 0.5, 0, 0, 0, 0]);
    expect(bandLevelsAt(bands, 4, 0.125)[0]).toBeCloseTo(0.5);
    expect(bandLevelsAt(bands, 4, 0.125)[1]).toBeCloseTo(0.25);
  });

  it('clamps beyond either end and is safe on an empty timeline', () => {
    expect(bandLevelsAt(bands, 4, -5)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(bandLevelsAt(bands, 4, 99)).toEqual([0, 1, 0, 0, 0, 0]);
    expect(bandLevelsAt([], 4, 1)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});
