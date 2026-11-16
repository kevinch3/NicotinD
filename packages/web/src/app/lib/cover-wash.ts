/**
 * The cover wash (#1687, theme audit Q3 B): a low-alpha tint from the artwork
 * over a surface, so Now Playing and an album or artist header pick up the
 * record's colour. Pure maths here; `CoverWashDirective` applies it.
 *
 * The alpha is the largest one, up to `COVER_WASH_MAX`, at which every text
 * level given still reads at `COVER_WASH_MIN_CONTRAST` over the washed surface.
 * If none does, there is no wash: legibility wins over colour.
 */
export type Rgb = readonly [number, number, number];

export const COVER_WASH_MAX = 0.18;
export const COVER_WASH_MIN_CONTRAST = 4.5;
const STEP = 0.02;

/** `#rrggbb`, `rgb(r, g, b)` or `rgb(r g b)`; null for anything else (a translucent colour included). */
export function parseRgb(css: string | null | undefined): Rgb | null {
  const v = (css ?? '').trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const fn = /^rgb\(\s*(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)\s*\)$/i.exec(v);
  return fn ? [Number(fn[1]), Number(fn[2]), Number(fn[3])] : null;
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2.x contrast ratio. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `top` at `alpha` over `under`, in sRGB: what the browser paints for the wash. */
export function washOver(top: Rgb, alpha: number, under: Rgb): Rgb {
  const mix = (t: number, u: number) => t * alpha + u * (1 - alpha);
  return [mix(top[0], under[0]), mix(top[1], under[1]), mix(top[2], under[2])];
}

/**
 * The wash for a cover's dominant colour over `surface`, as a CSS colour, with
 * the alpha it settled on; null when no alpha keeps every text level legible.
 */
export function coverWash(
  dominant: Rgb,
  surface: Rgb,
  texts: readonly Rgb[],
): { alpha: number; css: string } | null {
  for (let alpha = COVER_WASH_MAX; alpha >= STEP - 1e-9; alpha -= STEP) {
    const a = Math.round(alpha * 100) / 100;
    const washed = washOver(dominant, a, surface);
    if (texts.every((t) => contrastRatio(t, washed) >= COVER_WASH_MIN_CONTRAST)) {
      const [r, g, b] = dominant.map((c) => Math.round(c)) as [number, number, number];
      return { alpha: a, css: `rgb(${r} ${g} ${b} / ${a})` };
    }
  }
  return null;
}
