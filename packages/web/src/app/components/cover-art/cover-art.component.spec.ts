import {
  hashCode,
  placeholderGradient,
  placeholderInitial,
  placeholderFontSize,
} from './cover-art.component';

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
    expect(hashCode('Artist A:Album 1')).not.toBe(hashCode('Artist B:Album 2'));
  });

  it('always maps to a valid gradient index (0–7)', () => {
    const GRADIENT_COUNT = 8;
    const keys = [
      'Pink Floyd:The Wall',
      'Radiohead:OK Computer',
      'David Bowie:Ziggy Stardust',
      ':',
      'Artist:',
      ':Album',
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

describe('placeholderGradient (themed coverless fallback)', () => {
  it('builds the gradient from theme tokens, not a fixed palette', () => {
    const g = placeholderGradient('Maná', 'Sueños Líquidos');
    expect(g).toContain('var(--theme-accent)');
    expect(g).toContain('var(--theme-surface-2)');
    // No hardcoded hex colors leaking from the old rainbow palette.
    expect(g).not.toMatch(/#[0-9a-f]{6}/i);
  });

  it('is deterministic and varies the angle per item', () => {
    const a = placeholderGradient('A', '1');
    const b = placeholderGradient('Radiohead', 'OK Computer');
    expect(a).toBe(placeholderGradient('A', '1'));
    expect(a).not.toBe(b);
  });

  it('always produces a valid CSS angle (0–359deg)', () => {
    for (const key of [
      ['', ''],
      ['Artist', ''],
      ['', 'Album'],
      ['Sigur Rós', 'Ágætis byrjun'],
    ]) {
      const m = /linear-gradient\((\d+)deg/.exec(placeholderGradient(key[0], key[1]));
      expect(m).toBeTruthy();
      const angle = Number(m![1]);
      expect(angle).toBeGreaterThanOrEqual(0);
      expect(angle).toBeLessThan(360);
    }
  });
});

describe('placeholderInitial', () => {
  it('prefers the album, then artist, uppercased', () => {
    expect(placeholderInitial('Discovery', 'Daft Punk')).toBe('D');
    expect(placeholderInitial('', 'radiohead')).toBe('R');
  });

  it('falls back to ? when both are empty', () => {
    expect(placeholderInitial('', '')).toBe('?');
  });
});

describe('placeholderFontSize', () => {
  it('scales with px size when fixed', () => {
    expect(placeholderFontSize(80, false)).toBe('28px');
    expect(placeholderFontSize(40, false)).toBe('14px');
  });

  it('uses a fixed default when filling or size is unknown', () => {
    expect(placeholderFontSize(80, true)).toBe('2rem');
    expect(placeholderFontSize(undefined, false)).toBe('2rem');
  });
});
