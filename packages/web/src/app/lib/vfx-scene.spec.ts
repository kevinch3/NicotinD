import { describe, expect, it } from 'vitest';
import { vfxShapes } from './vfx-scene';

const W = 800;
const H = 600;

describe('vfxShapes', () => {
  it('returns one shape per band, all inside the canvas', () => {
    const shapes = vfxShapes([0.2, 0.9, 0.4, 0.6, 0.1, 0.3], 12.5, W, H);
    expect(shapes).toHaveLength(6);
    for (const s of shapes) {
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.x).toBeLessThanOrEqual(W);
      expect(s.y).toBeGreaterThanOrEqual(0);
      expect(s.y).toBeLessThanOrEqual(H);
      expect(s.radius).toBeGreaterThan(0);
      expect(s.alpha).toBeGreaterThanOrEqual(0);
      expect(s.alpha).toBeLessThanOrEqual(1);
    }
  });

  it('grows a band’s shape with its level and keeps silence small', () => {
    const quiet = vfxShapes([0, 0, 0, 0, 0, 0], 0, W, H);
    const loud = vfxShapes([1, 1, 1, 1, 1, 1], 0, W, H);
    for (let b = 0; b < 6; b++) {
      expect(loud[b]!.radius).toBeGreaterThan(quiet[b]!.radius);
      expect(loud[b]!.alpha).toBeGreaterThan(quiet[b]!.alpha);
    }
    // Silence still draws *something* faint — the overlay must not go black.
    expect(Math.max(...quiet.map((s) => s.radius))).toBeGreaterThan(0);
  });

  it('drifts with time so a sustained level still moves', () => {
    const a = vfxShapes([0.5, 0.5, 0.5, 0.5, 0.5, 0.5], 0, W, H);
    const b = vfxShapes([0.5, 0.5, 0.5, 0.5, 0.5, 0.5], 3.7, W, H);
    const moved = a.some((s, i) => s.x !== b[i]!.x || s.y !== b[i]!.y);
    expect(moved).toBe(true);
  });

  it('scales with the canvas size', () => {
    const small = vfxShapes([0.5, 0.5, 0.5, 0.5, 0.5, 0.5], 0, 200, 100);
    const large = vfxShapes([0.5, 0.5, 0.5, 0.5, 0.5, 0.5], 0, 2000, 1000);
    expect(large[1]!.radius).toBeGreaterThan(small[1]!.radius);
  });
});
