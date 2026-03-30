import { describe, expect, it } from 'bun:test';
import { resolveTheme, THEME_PRESETS, type ThemeId } from './theme';

describe('THEME_PRESETS', () => {
  const EXPECTED_IDS: ThemeId[] = ['midnight', 'daylight', 'warm-paper', 'oled', 'twilight', 'forest'];

  it('contains exactly 6 presets', () => {
    expect(THEME_PRESETS).toHaveLength(6);
  });

  it('includes all required theme IDs', () => {
    const ids = THEME_PRESETS.map((p) => p.id);
    for (const id of EXPECTED_IDS) {
      expect(ids).toContain(id);
    }
  });

  it('every preset has a non-empty name', () => {
    for (const preset of THEME_PRESETS) {
      expect(preset.name.length).toBeGreaterThan(0);
    }
  });

  it('midnight is first (used as default)', () => {
    expect(THEME_PRESETS[0].id).toBe('midnight');
  });
});

describe('resolveTheme', () => {
  it('returns the chosen theme when systemTheme is false', () => {
    expect(resolveTheme('daylight', false, true)).toBe('daylight');
    expect(resolveTheme('forest', false, false)).toBe('forest');
    expect(resolveTheme('oled', false, true)).toBe('oled');
  });

  it('ignores the isLight arg when systemTheme is false', () => {
    expect(resolveTheme('twilight', false, true)).toBe('twilight');
    expect(resolveTheme('twilight', false, false)).toBe('twilight');
  });

  it('returns daylight when systemTheme is true and OS is light', () => {
    expect(resolveTheme('midnight', true, true)).toBe('daylight');
    expect(resolveTheme('forest', true, true)).toBe('daylight');
  });

  it('returns midnight when systemTheme is true and OS is dark', () => {
    expect(resolveTheme('daylight', true, false)).toBe('midnight');
    expect(resolveTheme('warm-paper', true, false)).toBe('midnight');
  });
});
