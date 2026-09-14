import { describe, it, expect } from 'vitest';
import {
  computePaletteFromPixels,
  loadCoverPalette,
  DEFAULT_PALETTE,
  type PaletteImage,
} from './cover-colors';

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

describe('loadCoverPalette', () => {
  // jsdom never fires load/error on an <img> and has no 2D canvas, so the image
  // is injected and the two paths that can be reached here are the ones that
  // matter for a caller: it always resolves, and it resolves to the default.
  function fakeImage(): PaletteImage & { fire: (event: 'onload' | 'onerror') => void } {
    const img: PaletteImage & { fire: (event: 'onload' | 'onerror') => void } = {
      crossOrigin: null,
      onload: null,
      onerror: null,
      src: '',
      fire: (event) => img[event]?.(),
    };
    return img;
  }

  it('asks for the cover anonymously so the canvas is not tainted', async () => {
    const img = fakeImage();
    const pending = loadCoverPalette('/api/cover/x', { createImage: () => img });
    expect(img.crossOrigin).toBe('anonymous');
    expect(img.src).toBe('/api/cover/x');
    img.fire('onerror');
    await pending;
  });

  it('resolves to the default palette when the cover cannot be loaded', async () => {
    const img = fakeImage();
    const pending = loadCoverPalette('/api/cover/x', { createImage: () => img });
    img.fire('onerror');
    expect(await pending).toEqual(DEFAULT_PALETTE);
  });

  it('resolves to the default palette when the canvas cannot give pixels', async () => {
    const img = fakeImage();
    const pending = loadCoverPalette('/api/cover/x', { createImage: () => img });
    img.fire('onload');
    expect(await pending).toEqual(DEFAULT_PALETTE);
  });
});
