/**
 * WCAG 2.x contrast for the theme contrast table (#1684). Pure: the spec reads
 * computed colours in the browser and does the arithmetic here, so the table
 * measures what the page paints, aliases included. → docs/web-ui.md
 */
export type Rgba = { r: number; g: number; b: number; a: number };

/** `#rrggbb`, `rgb(r, g, b)` or `rgba(r, g, b, a)`, as computed styles report them. */
export function parseColor(value: string): Rgba {
  const v = value.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const fn = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(
    v,
  );
  if (!fn) throw new Error(`unparseable colour: ${value}`);
  const alpha = fn[4] === undefined ? 1 : fn[4].endsWith('%') ? parseFloat(fn[4]) / 100 : +fn[4];
  return { r: +fn[1]!, g: +fn[2]!, b: +fn[3]!, a: alpha };
}

/** `top` painted over an opaque `under`. */
export function composite(top: Rgba, under: Rgba): Rgba {
  const mix = (t: number, u: number) => t * top.a + u * (1 - top.a);
  return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b), a: 1 };
}

function luminance({ r, g, b }: Rgba): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Contrast ratio of two opaque colours, 1 to 21. */
export function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
