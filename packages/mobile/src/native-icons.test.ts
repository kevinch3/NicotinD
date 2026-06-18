import { describe, expect, it } from 'bun:test';
import {
  BRAND,
  FOREGROUND_SAFE_ZONE,
  SPLASH_DISC_FRACTION,
  backgroundSvg,
  foregroundSvg,
  fullIconSvg,
  splashSvg,
} from './native-icons.js';

describe('fullIconSvg', () => {
  it('matches the web manifest brand mark (solid bg + indigo disc + play glyph)', () => {
    const svg = fullIconSvg();
    expect(svg).toContain('viewBox="0 0 100 100"');
    expect(svg).toContain(`<rect width="100" height="100" fill="${BRAND.background}"/>`);
    expect(svg).toContain(`<circle cx="50" cy="50" r="40" fill="${BRAND.accent}"/>`);
    expect(svg).toContain(`<polygon points="42,32 70,50 42,68" fill="${BRAND.mark}"/>`);
  });

  it('is opaque (no transparency) — iOS forbids alpha in the app icon', () => {
    // The background rect covers the whole canvas before the glyph is drawn.
    expect(fullIconSvg().indexOf('<rect')).toBeLessThan(fullIconSvg().indexOf('<circle'));
    expect(fullIconSvg()).not.toContain('fill="none"');
  });
});

describe('backgroundSvg', () => {
  it('is a solid brand-background fill with no glyph', () => {
    const svg = backgroundSvg();
    expect(svg).toContain(`fill="${BRAND.background}"`);
    expect(svg).not.toContain('<circle');
    expect(svg).not.toContain('<polygon');
  });
});

describe('foregroundSvg', () => {
  it('carries only the glyph (transparent background for the adaptive layer)', () => {
    const svg = foregroundSvg();
    expect(svg).not.toContain('<rect');
    expect(svg).toContain('<circle');
    expect(svg).toContain('<polygon');
  });

  it('scales the glyph into the safe zone about the canvas centre', () => {
    // scale 0.66 → offset 50*(1-0.66) = 17, well inside the 0..100 canvas.
    const offset = 50 * (1 - FOREGROUND_SAFE_ZONE);
    expect(foregroundSvg()).toContain(
      `transform="translate(${offset} ${offset}) scale(${FOREGROUND_SAFE_ZONE})"`,
    );
  });

  it('keeps the scaled glyph strictly inside the launcher safe zone', () => {
    // The disc (r=40, edge at 90/100) scaled by s about centre has its far edge
    // at 50 + 40*s. For any safe-zone scale < 1 it must stay below 100 (no clip).
    const edge = 50 + 40 * FOREGROUND_SAFE_ZONE;
    expect(edge).toBeLessThan(84); // comfortably within the ~66% safe zone
  });

  it('honours a custom scale', () => {
    expect(foregroundSvg(0.5)).toContain('translate(25 25) scale(0.5)');
  });
});

describe('splashSvg', () => {
  it('is the brand mark on the solid dark field', () => {
    const svg = splashSvg();
    expect(svg).toContain(`<rect width="100" height="100" fill="${BRAND.background}"/>`);
    expect(svg).toContain(`<circle cx="50" cy="50" r="40" fill="${BRAND.accent}"/>`);
    expect(svg).toContain(`<polygon points="42,32 70,50 42,68" fill="${BRAND.mark}"/>`);
  });

  it('centres the mark and sizes the disc to SPLASH_DISC_FRACTION of the canvas', () => {
    const scale = (SPLASH_DISC_FRACTION * 100) / 80;
    expect(splashSvg()).toContain(`translate(50 50) scale(${scale}) translate(-50 -50)`);
  });

  it('keeps the mark small and centred (never cropped on any aspect ratio)', () => {
    // Disc half-width after scaling, measured from canvas centre (50).
    const discHalf = 40 * ((SPLASH_DISC_FRACTION * 100) / 80);
    expect(50 - discHalf).toBeGreaterThan(30); // comfortably inside the canvas
    expect(50 + discHalf).toBeLessThan(70);
  });

  it('honours a custom disc fraction', () => {
    const scale = (0.5 * 100) / 80;
    expect(splashSvg(0.5)).toContain(`scale(${scale})`);
  });
});
