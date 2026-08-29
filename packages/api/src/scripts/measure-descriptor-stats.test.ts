import { describe, expect, it } from 'bun:test';
import { descriptorStats, renderNormLiteral } from './measure-descriptor-stats.js';

describe('descriptorStats', () => {
  it('computes per-feature mean and population sd, ignoring nulls', () => {
    const rows = [
      JSON.stringify({ a: 1, b: null }),
      JSON.stringify({ a: 3, b: 2 }),
      JSON.stringify({ a: 5, b: 4 }),
    ];
    const s = descriptorStats(rows);
    expect(s.n).toBe(3);
    expect(s.stats.a!.mean).toBe(3);
    expect(s.stats.a!.sd).toBeCloseTo(Math.sqrt(8 / 3), 12);
    expect(s.stats.a!.n).toBe(3);
    expect(s.stats.b!.mean).toBe(3);
    expect(s.stats.b!.sd).toBeCloseTo(1, 12);
    expect(s.stats.b!.n).toBe(2);
  });

  it('skips rows that are not valid JSON objects', () => {
    const s = descriptorStats(['{not json', JSON.stringify({ a: 2 }), JSON.stringify([1, 2])]);
    expect(s.n).toBe(1);
    expect(s.stats.a).toEqual({ mean: 2, sd: 0, n: 1 });
  });
});

describe('renderNormLiteral', () => {
  it('emits a TS literal with the sample provenance, sorted by name', () => {
    const out = renderNormLiteral(
      { n: 2, stats: { b: { mean: 1.23456, sd: 0.5, n: 2 }, a: { mean: -600, sd: 50, n: 2 } } },
      '2026-08-23',
    );
    expect(out).toContain('n: 2');
    expect(out).toContain("measuredAt: '2026-08-23'");
    expect(out.indexOf('  a:')).toBeLessThan(out.indexOf('  b:'));
    expect(out).toContain('a: { mean: -600, sd: 50 }');
    expect(out).toContain('b: { mean: 1.2346, sd: 0.5 }');
  });
});
