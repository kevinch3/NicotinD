import { describe, expect, it } from 'bun:test';
import { computeEnergy, parseEbur128Output } from './loudness-analysis.js';

/** Realistic tail of ffmpeg `-filter:a ebur128` stderr output. */
const SUMMARY = `
[Parsed_ebur128_0 @ 0x55c9] t: 212.8      TARGET:-23 LUFS    M: -10.4 S: -10.1     I:  -9.3 LUFS       LRA:  6.2 LU
[Parsed_ebur128_0 @ 0x55c9] Summary:

  Integrated loudness:
    I:         -9.3 LUFS
    Threshold: -19.5 LUFS

  Loudness range:
    LRA:        6.2 LU
    Threshold: -29.4 LUFS
    LRA low:   -13.6 LUFS
    LRA high:   -7.4 LUFS
`;

describe('parseEbur128Output', () => {
  it('parses I and LRA from the summary block', () => {
    expect(parseEbur128Output(SUMMARY)).toEqual({ integratedLufs: -9.3, loudnessRange: 6.2 });
  });

  it('ignores the periodic per-frame lines and only reads the Summary', () => {
    // The per-frame line above carries I: -9.3 too, but a doctored frame value
    // must not win over the summary.
    const doctored = SUMMARY.replace('t: 212.8      TARGET:-23 LUFS    M: -10.4 S: -10.1     I:  -9.3', 't: 212.8 I: -3.0');
    expect(parseEbur128Output(doctored)?.integratedLufs).toBe(-9.3);
  });

  it('maps -inf (silence) to the silence floor', () => {
    const silent = 'Summary:\n  Integrated loudness:\n    I:   -inf LUFS\n  Loudness range:\n    LRA: 0.0 LU\n';
    expect(parseEbur128Output(silent)).toEqual({ integratedLufs: -70, loudnessRange: 0 });
  });

  it('returns null when no summary is present', () => {
    expect(parseEbur128Output('ffmpeg exploded')).toBeNull();
    expect(parseEbur128Output('')).toBeNull();
  });

  it('tolerates a missing LRA line (defaults to 0)', () => {
    const noLra = 'Summary:\n  Integrated loudness:\n    I: -12.0 LUFS\n';
    expect(parseEbur128Output(noLra)).toEqual({ integratedLufs: -12, loudnessRange: 0 });
  });
});

describe('computeEnergy', () => {
  it('is always within [0, 1]', () => {
    for (const lufs of [-80, -40, -25, -14, -9, -5, 0, 10]) {
      for (const lra of [0, 3, 8, 15, 25]) {
        const e = computeEnergy(lufs, lra);
        expect(e).toBeGreaterThanOrEqual(0);
        expect(e).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is monotonically non-decreasing in loudness for a fixed range', () => {
    let prev = -1;
    for (let lufs = -40; lufs <= 0; lufs += 1) {
      const e = computeEnergy(lufs, 6);
      expect(e).toBeGreaterThanOrEqual(prev);
      prev = e;
    }
  });

  it('scores a loud compressed master higher than a quiet dynamic one', () => {
    const clubMaster = computeEnergy(-7, 3); // loud, compressed
    const ambient = computeEnergy(-24, 14); // quiet, dynamic
    expect(clubMaster).toBeGreaterThan(0.9);
    expect(ambient).toBeLessThan(0.15);
  });

  it('damps energy for very dynamic material at equal loudness', () => {
    expect(computeEnergy(-10, 18)).toBeLessThan(computeEnergy(-10, 3));
  });

  it('scores silence as zero', () => {
    expect(computeEnergy(-70, 0)).toBe(0);
  });
});
