import { describe, expect, it } from 'bun:test';
import { hashCode } from './CoverArt';

describe('hashCode', () => {
  it('returns a non-negative integer', () => {
    expect(hashCode('Pink Floyd:The Wall')).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(hashCode('Pink Floyd:The Wall'))).toBe(true);
  });

  it('is deterministic — same input always gives same output', () => {
    const key = 'Radiohead:OK Computer';
    expect(hashCode(key)).toBe(hashCode(key));
  });

  it('returns 0 for the empty string', () => {
    expect(hashCode('')).toBe(0);
  });

  it('produces different values for different inputs', () => {
    // Not a strict guarantee but should hold for any two distinct real keys
    expect(hashCode('Artist A:Album 1')).not.toBe(hashCode('Artist B:Album 2'));
  });

  it('always maps to a valid gradient index (0–7)', () => {
    const GRADIENT_COUNT = 8;
    const keys = [
      'Pink Floyd:The Wall',
      'Radiohead:OK Computer',
      'David Bowie:Ziggy Stardust',
      ':',           // edge: both parts empty
      'Artist:',     // edge: no album
      ':Album',      // edge: no artist
    ];
    for (const key of keys) {
      const idx = hashCode(key) % GRADIENT_COUNT;
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(GRADIENT_COUNT);
    }
  });

  it('handles unicode input without throwing', () => {
    expect(() => hashCode('Sigur Rós:Ágætis byrjun')).not.toThrow();
  });
});
