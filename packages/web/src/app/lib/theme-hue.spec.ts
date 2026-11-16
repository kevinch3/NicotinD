import { describe, expect, it } from 'vitest';
import { THEME_HUE_COUNT, themeHue, themeHueIndex } from './theme-hue';

describe('themeHue (#1686)', () => {
  it('is stable for a key', () => {
    expect(themeHue('Chacarera')).toBe(themeHue('Chacarera'));
    expect(themeHueIndex('Chacarera')).toBe(themeHueIndex('Chacarera'));
  });

  it('is one of the eight tokens', () => {
    for (const key of ['', 'Rock', 'Pop', 'Folclore', 'Ágætis byrjun', '日本語']) {
      const n = themeHueIndex(key);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(THEME_HUE_COUNT);
      expect(themeHue(key)).toBe(`var(--theme-hue-${n})`);
    }
  });

  it('spreads keys over all eight', () => {
    const seen = new Set(Array.from({ length: 200 }, (_, i) => themeHueIndex(`genre ${i}`)));
    expect(seen.size).toBe(THEME_HUE_COUNT);
  });
});
