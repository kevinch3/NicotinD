/**
 * Cover-art palette extraction for karaoke mode. The pure pixel→palette core
 * lives here (DOM-free, unit-testable); the component keeps only the thin
 * Image/<canvas> loading shell that feeds raw RGBA into computePaletteFromPixels.
 */

export interface CoverPalette {
  primary: string;
  secondary: string;
  glow: string;
}

/** Fallback gradient when a cover can't be loaded or yields too few samples. */
export const DEFAULT_PALETTE: CoverPalette = {
  primary: '#1a1a2e',
  secondary: '#16213e',
  glow: '#0f3460',
};

type RGB = [number, number, number];

const darken = (c: RGB, f: number): string =>
  `rgb(${Math.round(c[0] * f)}, ${Math.round(c[1] * f)}, ${Math.round(c[2] * f)})`;

/**
 * Derive a two-tone karaoke gradient from raw RGBA pixel data (as produced by
 * `CanvasRenderingContext2D.getImageData().data`). Samples every 4th pixel,
 * drops near-black/near-white outliers, then runs k=2 k-means to find the two
 * dominant clusters, darkened for white-text readability. Returns
 * {@link DEFAULT_PALETTE} when fewer than two usable samples remain.
 */
export function computePaletteFromPixels(data: Uint8ClampedArray): CoverPalette {
  const colors: RGB[] = [];
  for (let i = 0; i < data.length; i += 16) {
    const r = data[i]!,
      g = data[i + 1]!,
      b = data[i + 2]!;
    const brightness = (r + g + b) / 3;
    if (brightness > 20 && brightness < 240) {
      colors.push([r, g, b]);
    }
  }
  if (colors.length < 2) return DEFAULT_PALETTE;

  let c1 = colors[0]!;
  let c2 = colors[Math.floor(colors.length / 2)]!;
  for (let iter = 0; iter < 5; iter++) {
    const g1: RGB[] = [];
    const g2: RGB[] = [];
    for (const c of colors) {
      const d1 = (c[0] - c1[0]) ** 2 + (c[1] - c1[1]) ** 2 + (c[2] - c1[2]) ** 2;
      const d2 = (c[0] - c2[0]) ** 2 + (c[1] - c2[1]) ** 2 + (c[2] - c2[2]) ** 2;
      (d1 <= d2 ? g1 : g2).push(c);
    }
    if (g1.length > 0) {
      c1 = [
        Math.round(g1.reduce((s, c) => s + c[0], 0) / g1.length),
        Math.round(g1.reduce((s, c) => s + c[1], 0) / g1.length),
        Math.round(g1.reduce((s, c) => s + c[2], 0) / g1.length),
      ];
    }
    if (g2.length > 0) {
      c2 = [
        Math.round(g2.reduce((s, c) => s + c[0], 0) / g2.length),
        Math.round(g2.reduce((s, c) => s + c[1], 0) / g2.length),
        Math.round(g2.reduce((s, c) => s + c[2], 0) / g2.length),
      ];
    }
  }

  return {
    primary: darken(c1, 0.35),
    secondary: darken(c2, 0.3),
    glow: darken(c1, 0.5),
  };
}

/**
 * Smooth-scroll the active karaoke line to the vertical centre of its
 * container. Pure DOM (no Angular); the reactive trigger stays in the component.
 * No-op when the index is out of range.
 */
export function scrollToActiveLine(container: HTMLElement, index: number): void {
  if (index < 0) return;
  const lines = container.querySelectorAll('[data-karaoke-line]');
  const el = lines[index] as HTMLElement | undefined;
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
