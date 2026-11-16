import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
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

// The surfaces that wear a hue (#1686). Each sets `--tone-hue` on a `.hue-tone`
// element; none of them falls back to the accent, which says "press me".
describe('hue-toned surfaces', () => {
  const APP = join(__dirname, '..');
  const template = (rel: string) => readFileSync(join(APP, rel), 'utf8');
  const element = (html: string, testid: string) => {
    const at = html.indexOf(`data-testid="${testid}"`);
    expect(at, `${testid} is in the template`).toBeGreaterThan(-1);
    return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at));
  };

  it.each([
    ['pages/library/library.component.html', 'genre-tile', 'genreHue(genre.value)'],
    ['components/track-info-sheet/track-info-sheet.component.html', 'genre-chip', 'genreHue(g)'],
  ])('%s: %s is tinted by its genre', (file, testid, binding) => {
    const tag = element(template(file), testid);
    expect(tag).toContain('hue-tone');
    expect(tag).toContain(`[style.--tone-hue]="${binding}"`);
    // A drop-target ring may still use the accent: that one is an interaction cue.
    expect(tag).not.toMatch(/(?:bg|text)-theme-accent/);
  });
});
