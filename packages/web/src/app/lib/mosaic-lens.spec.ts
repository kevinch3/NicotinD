import { describe, expect, it } from 'vitest';
import { COS_MAX, THETA_MAX, visiblePlacements } from './mosaic-lens';
import type { PackedTile } from './mosaic-packing';
import type { MosaicTile } from './mosaic-tiles';

const mosaicTile = (key: string): MosaicTile => ({
  key,
  kind: 'song',
  title: key,
  subtitle: '',
  score: 0.5,
  action: { type: 'song', track: { id: key, title: key, artist: 'A' } },
});

const packed = (id: number, x: number, y: number, size = 100): PackedTile => ({
  tile: mosaicTile(`song:${id}`),
  id,
  x,
  y,
  size,
  half: size / 2,
});

const VIEW = { w: 800, h: 600 };
const W = 1600;
const R = 600;

describe('visiblePlacements', () => {
  it('puts the tile under the camera at the viewport centre, unscaled', () => {
    const out = visiblePlacements([packed(0, 800, 800)], { x: 800, y: 800 }, VIEW, W, R);
    const centre = out.find((p) => p.packed.id === 0 && p.left === VIEW.w / 2 - 50);
    expect(centre).toBeDefined();
    expect(centre!.scale).toBeCloseTo(1, 5);
    expect(centre!.top).toBeCloseTo(VIEW.h / 2 - 50);
    expect(centre!.opacity).toBe(1);
  });

  it('shrinks tiles toward the rim', () => {
    const near = visiblePlacements([packed(0, 800, 800)], { x: 800, y: 800 }, VIEW, W, R);
    const far = visiblePlacements([packed(0, 800, 800)], { x: 500, y: 800 }, VIEW, W, R);
    expect(far[0].scale).toBeLessThan(near[0].scale);
  });

  // Past THETA_MAX the plane has curved out of view; without the cull, tiles
  // pile up at the rim at full size instead of receding.
  it('culls everything beyond the lens angle', () => {
    const beyond = R * THETA_MAX + 10;
    const out = visiblePlacements([packed(0, 800 + beyond, 800)], { x: 800, y: 800 }, VIEW, W, R);
    expect(out.filter((p) => Math.abs(p.scale - 1) < 1e-6)).toHaveLength(0);
  });

  it('never returns a scale below the rim cosine', () => {
    const many = Array.from({ length: 30 }, (_, i) => packed(i, (i * 137) % W, (i * 251) % W));
    for (const p of visiblePlacements(many, { x: 400, y: 900 }, VIEW, W, R)) {
      expect(p.scale).toBeGreaterThanOrEqual(COS_MAX - 1e-6);
      expect(p.opacity).toBeGreaterThanOrEqual(0);
      expect(p.opacity).toBeLessThanOrEqual(1);
    }
  });

  it('gives every visible copy of a tile its own pool key', () => {
    // A lens wide enough to reach past the patch sees the same tile more than
    // once; identical keys would make the copies fight over one pooled element.
    // The patch (400) must be well inside the lens reach (R * THETA_MAX ≈ 690)
    // for a second copy to land on screen at all.
    const out = visiblePlacements([packed(0, 0, 0)], { x: 0, y: 0 }, VIEW, 400, R);
    const keys = out.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBeGreaterThan(1);
  });

  it('returns nothing for an empty patch', () => {
    expect(visiblePlacements([], { x: 0, y: 0 }, VIEW, W, R)).toEqual([]);
  });

  it('wraps: panning a whole patch width lands on the same picture', () => {
    const key = (cam: { x: number; y: number }): string[] =>
      visiblePlacements([packed(0, 800, 800)], cam, VIEW, W, R)
        .map((p) => `${p.left.toFixed(2)},${p.top.toFixed(2)},${p.scale.toFixed(4)}`)
        .sort();
    expect(key({ x: 800, y: 800 })).toEqual(key({ x: 800 + W, y: 800 }));
  });
});
