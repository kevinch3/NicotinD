import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A `.glass-panel` (#1638) is translucent over content of unknown colour: the
 * entity menu over the mosaic's artwork. Its items are secondary text, so on
 * every theme the surface it keeps (`--theme-glass-alpha`) must hold 4.5:1 over
 * the worst backdrops there are: pure white and pure black. The floor differs
 * per theme (measured: twilight needs 93%, daylight 80%), which is why the
 * value is a token and this reads the real stylesheet rather than a copy.
 */
const css = readFileSync(join(__dirname, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

interface Rule {
  selectors: string[];
  body: string;
}

const rules: Rule[] = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: m[1]
    .replace(/@layer\s+\w+\s*$/, '')
    .split(',')
    .map((s) => s.trim()),
  body: m[2],
}));

const prop = (body: string, name: string): string | undefined =>
  body.match(new RegExp(`--theme-${name}:\\s*([^;]+);`))?.[1].trim();

const forTheme = (theme: string): Rule[] =>
  rules.filter((r) => r.selectors.includes(`[data-theme="${theme}"]`));

/** Every theme that defines its own palette. */
const themes = [...css.matchAll(/\[data-theme="([a-z-]+)"\]/g)]
  .map((m) => m[1])
  .filter((t, i, all) => all.indexOf(t) === i)
  .filter((t) => forTheme(t).some((r) => prop(r.body, 'surface')));

/** The theme's own value, else the `:root` default — the cascade, for one property. */
const resolve = (theme: string, name: string): string => {
  const own = forTheme(theme)
    .map((r) => prop(r.body, name))
    .filter((v): v is string => v !== undefined);
  if (own.length > 0) return own[own.length - 1];
  const root = rules
    .filter((r) => r.selectors.includes(':root'))
    .map((r) => prop(r.body, name))
    .filter((v): v is string => v !== undefined);
  if (root.length === 0) throw new Error(`--theme-${name} has no value for ${theme}`);
  return root[root.length - 1];
};

const rgb = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const luminance = (c: number[]): number => {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: number[], b: number[]): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('glass panels keep their text legible on every theme', () => {
  it('reads all seven palettes, so a theme added later is checked too', () => {
    expect(themes).toEqual(
      expect.arrayContaining([
        'midnight',
        'daylight',
        'warm-paper',
        'oled',
        'twilight',
        'forest',
        'eink',
      ]),
    );
  });

  it.each(themes)('%s: secondary text holds 4.5:1 over white and over black', (theme) => {
    const surface = rgb(resolve(theme, 'surface'));
    const text = rgb(resolve(theme, 'text-secondary'));
    const alpha = parseFloat(resolve(theme, 'glass-alpha')) / 100;
    for (const backdrop of [0, 255]) {
      const panel = surface.map((c) => c * alpha + backdrop * (1 - alpha));
      expect(contrast(text, panel), `over ${backdrop ? 'white' : 'black'}`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it('eink keeps the whole surface — no transparency there, by policy', () => {
    expect(resolve('eink', 'glass-alpha')).toBe('100%');
  });
});
