import { describe, expect, it } from 'bun:test';
import {
  BAND_NAMES,
  GROOVE_NAMES,
  TIMBRE_NAMES,
  blockCosineCloseness,
  descriptorBlocks,
  meanBlock,
  spectralBalanceCloseness,
} from './descriptor-axes.js';
import type { DescriptorNorm } from './descriptor-norm.js';

/** A norm where every feature is mean 0, sd 1 — z-scores pass through. */
const IDENTITY_NORM: DescriptorNorm = Object.fromEntries(
  [...TIMBRE_NAMES, ...GROOVE_NAMES].map((n) => [n, { mean: 0, sd: 1 }]),
);

function features(overrides: Record<string, number | null> = {}): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const n of TIMBRE_NAMES) out[n] = 1;
  for (const n of GROOVE_NAMES) out[n] = 0.5;
  for (const n of BAND_NAMES) out[n] = 1 / 6;
  return { ...out, ...overrides };
}

describe('block definitions', () => {
  it('mirror the sidecar contract: 21 timbre, 8 groove, 6 band names', () => {
    expect(TIMBRE_NAMES).toHaveLength(21);
    expect(GROOVE_NAMES).toHaveLength(8);
    expect(BAND_NAMES).toEqual([
      'band_sub_bass',
      'band_bass',
      'band_low_mid',
      'band_mid',
      'band_high_mid',
      'band_high',
    ]);
    expect(TIMBRE_NAMES[0]).toBe('mfcc_0');
    expect(TIMBRE_NAMES[12]).toBe('mfcc_12');
  });
});

describe('descriptorBlocks', () => {
  it('z-scores timbre and groove against the norm and passes band shares through', () => {
    const norm: DescriptorNorm = {
      ...IDENTITY_NORM,
      mfcc_0: { mean: -600, sd: 100 },
      onset_rate: { mean: 4, sd: 2 },
    };
    const b = descriptorBlocks(features({ mfcc_0: -500, onset_rate: 6 }), norm);
    expect(b.timbre).toHaveLength(21);
    expect(b.timbre![0]).toBeCloseTo(1); // (-500 − -600) / 100
    expect(b.timbre![1]).toBeCloseTo(1); // identity norm
    expect(b.groove![0]).toBeCloseTo(1); // (6 − 4) / 2
    expect(b.bands).toEqual(new Array(6).fill(1 / 6));
  });

  it('treats a missing value as the population mean (z = 0), never as a hole', () => {
    const b = descriptorBlocks(features({ swing_ratio: null }), IDENTITY_NORM);
    const i = GROOVE_NAMES.indexOf('swing_ratio');
    expect(b.groove![i]).toBe(0);
  });

  it('drops a block when more than half of it is missing — nothing to compare', () => {
    const mostlyNull: Record<string, number | null> = {};
    for (const n of GROOVE_NAMES.slice(0, 5)) mostlyNull[n] = null;
    const b = descriptorBlocks(features(mostlyNull), IDENTITY_NORM);
    expect(b.groove).toBeUndefined();
    expect(b.timbre).toBeDefined();
  });

  it('drops the band block when any share is missing (silence) — shares must sum to one', () => {
    const b = descriptorBlocks(features({ band_bass: null }), IDENTITY_NORM);
    expect(b.bands).toBeUndefined();
  });

  it('guards a degenerate norm (sd 0) so a constant feature cannot explode a z-score', () => {
    const norm: DescriptorNorm = { ...IDENTITY_NORM, mfcc_1: { mean: 5, sd: 0 } };
    const b = descriptorBlocks(features({ mfcc_1: 9 }), norm);
    expect(Number.isFinite(b.timbre![1]!)).toBe(true);
    expect(b.timbre![1]).toBe(0);
  });
});

describe('blockCosineCloseness', () => {
  it('maps cosine to 0..1: identical → 1, opposite → 0, orthogonal → 0.5', () => {
    expect(blockCosineCloseness([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(blockCosineCloseness([1, 2, 3], [-1, -2, -3])).toBeCloseTo(0);
    expect(blockCosineCloseness([1, 0], [0, 1])).toBeCloseTo(0.5);
  });

  it('is null (axis skipped) when a side is missing, empty, zero, or a different length', () => {
    expect(blockCosineCloseness(undefined, [1, 2])).toBeNull();
    expect(blockCosineCloseness([1, 2], [1, 2, 3])).toBeNull();
    expect(blockCosineCloseness([0, 0], [1, 2])).toBeNull();
    expect(blockCosineCloseness([], [])).toBeNull();
  });
});

describe('spectralBalanceCloseness', () => {
  it('is 1 for identical shares and 0 for disjoint ones (L1 distance over 2)', () => {
    const bassy = [0.3, 0.5, 0.1, 0.05, 0.03, 0.02];
    expect(spectralBalanceCloseness(bassy, bassy)).toBeCloseTo(1);
    expect(spectralBalanceCloseness([1, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 1])).toBeCloseTo(0);
    // Half the mass moved → halfway.
    expect(spectralBalanceCloseness([1, 0, 0, 0, 0, 0], [0.5, 0.5, 0, 0, 0, 0])).toBeCloseTo(0.5);
  });

  it('is null when a side is missing or mis-sized', () => {
    expect(spectralBalanceCloseness(undefined, [1, 0, 0, 0, 0, 0])).toBeNull();
    expect(spectralBalanceCloseness([1, 0], [1, 0, 0, 0, 0, 0])).toBeNull();
  });
});

describe('meanBlock', () => {
  it('averages the vectors that exist and ignores the missing ones', () => {
    expect(meanBlock([[1, 2], undefined, [3, 4]])).toEqual([2, 3]);
  });

  it('is undefined with nothing to average or mismatched lengths only', () => {
    expect(meanBlock([undefined, undefined])).toBeUndefined();
    expect(meanBlock([])).toBeUndefined();
    expect(
      meanBlock([
        [1, 2],
        [1, 2, 3],
      ]),
    ).toEqual([1, 2]); // odd-length members are skipped
  });
});
