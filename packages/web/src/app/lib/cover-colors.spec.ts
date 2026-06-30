import { describe, it, expect } from 'vitest';
import { computePaletteFromPixels, DEFAULT_PALETTE } from './cover-colors';

/** Build an RGBA buffer that repeats the given pixels `repeat` times. */
function rgba(pixels: Array<[number, number, number]>, repeat: number): Uint8ClampedArray {
  const out: number[] = [];
  for (let r = 0; r < repeat; r++) {
    for (const [red, green, blue] of pixels) out.push(red, green, blue, 255);
  }
  return new Uint8ClampedArray(out);
}

describe('computePaletteFromPixels', () => {
  it('returns the default palette when fewer than two usable samples remain', () => {
    // All pixels near-black → filtered out (brightness <= 20).
    expect(computePaletteFromPixels(rgba([[0, 0, 0]], 64))).toBe(DEFAULT_PALETTE);
    // All pixels near-white → filtered out (brightness >= 240).
    expect(computePaletteFromPixels(rgba([[255, 255, 255]], 64))).toBe(DEFAULT_PALETTE);
  });

  it('separates a bimodal image into two distinct darkened clusters', () => {
    // The sampler steps every 16 bytes (4 pixels). Use a 4-pixel red/blue
    // repeat so both clusters survive subsampling.
    const data = rgba(
      [
        [200, 40, 40],
        [40, 40, 200],
        [200, 40, 40],
        [40, 40, 200],
      ],
      16,
    );
    const palette = computePaletteFromPixels(data);
    expect(palette).not.toBe(DEFAULT_PALETTE);
    // Two clusters → primary and secondary differ.
    expect(palette.primary).not.toEqual(palette.secondary);
    // Colours are darkened rgb() strings.
    expect(palette.primary).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    expect(palette.glow).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
  });

  it('is deterministic for the same input', () => {
    const data = rgba(
      [
        [120, 200, 80],
        [80, 120, 200],
        [120, 200, 80],
        [80, 120, 200],
      ],
      16,
    );
    expect(computePaletteFromPixels(data)).toEqual(computePaletteFromPixels(data));
  });
});
