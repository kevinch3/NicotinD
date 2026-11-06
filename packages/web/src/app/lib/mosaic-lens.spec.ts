import { describe, expect, it } from 'vitest';
import {
  CENTER_SCALE,
  FISHEYE_K,
  FRICTION,
  RIM_SCALE,
  THETA_MAX,
  TILE_BASE,
  decayVelocity,
  visiblePlacements,
} from './mosaic-lens';
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
  it('puts the tile under the camera at the viewport centre, magnified (#1638 fisheye)', () => {
    const out = visiblePlacements([packed(0, 800, 800)], { x: 800, y: 800 }, VIEW, W, R);
    const centre = out.find((p) => p.packed.id === 0 && p.left === VIEW.w / 2 - 50);
    expect(centre).toBeDefined();
    expect(centre!.scale).toBeCloseTo(CENTER_SCALE, 2);
    expect(CENTER_SCALE).toBeGreaterThan(1.5);
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
    expect(out.filter((p) => p.i === 0 && p.j === 0)).toHaveLength(0);
  });

  // The fisheye is logarithmic: screen radius grows as ln(1 + K·u), so the
  // magnification (its slope) falls as 1/(1 + K·u) — its reciprocal is linear
  // in the distance from the camera.
  it('magnification falls off logarithmically: 1/scale grows linearly with distance', () => {
    const at = (d: number) =>
      visiblePlacements([packed(0, 800 + d, 800)], { x: 800, y: 800 }, VIEW, W, R)[0];
    const limit = R * THETA_MAX;
    const [a, b, c] = [0.1, 0.3, 0.5].map((u) => at(u * limit));
    const step1 = 1 / b.scale - 1 / a.scale;
    const step2 = 1 / c.scale - 1 / b.scale;
    expect(step2).toBeCloseTo(step1, 2);
    expect(step1 / (0.2 * FISHEYE_K)).toBeCloseTo(1 / CENTER_SCALE, 2);
    // …and screen distance itself is concave: equal plane steps cover less and less screen.
    const x = (p: ReturnType<typeof at>) => p.left + 50 - VIEW.w / 2;
    expect(x(b) - x(a)).toBeGreaterThan(x(c) - x(b));
  });

  // Packed at full size, the magnified gaps left the field sparse; the packing
  // base must compensate the centre so it stays about its old size, whatever K is.
  it('packs tiles small enough that the centre tile is about its pre-fisheye size', () => {
    expect(TILE_BASE * CENTER_SCALE).toBeGreaterThanOrEqual(1);
    expect(TILE_BASE * CENTER_SCALE).toBeLessThanOrEqual(1.2);
  });

  it('never returns a scale below the rim scale', () => {
    const many = Array.from({ length: 30 }, (_, i) => packed(i, (i * 137) % W, (i * 251) % W));
    for (const p of visiblePlacements(many, { x: 400, y: 900 }, VIEW, W, R)) {
      expect(p.scale).toBeGreaterThanOrEqual(RIM_SCALE - 1e-3);
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

  it('reports which torus copy each placement belongs to', () => {
    // The discovery cells key their content on (i, j); a placement that lied
    // about its copy would fetch or show the wrong cell's batch.
    const out = visiblePlacements([packed(0, 0, 0)], { x: 0, y: 0 }, VIEW, 400, R);
    for (const p of out) expect(p.key).toBe(`${p.packed.id}_${p.i}_${p.j}`);
    expect(new Set(out.map((p) => `${p.i},${p.j}`)).size).toBeGreaterThan(1);
  });
});

describe('decayVelocity', () => {
  it('decays by the friction factor while moving fast', () => {
    const { vx, vy } = decayVelocity(10, -4);
    expect(vx).toBeCloseTo(10 * FRICTION);
    expect(vy).toBeCloseTo(-4 * FRICTION);
  });

  it('snaps to a dead stop below the rest threshold — never an asymptote', () => {
    // Exponential decay alone never reaches zero; the camera would creep
    // sub-pixel forever and the mosaic would visibly "never stop".
    expect(decayVelocity(0.03, 0.03)).toEqual({ vx: 0, vy: 0 });
  });

  it('holds a stopped camera at exactly zero', () => {
    expect(decayVelocity(0, 0)).toEqual({ vx: 0, vy: 0 });
  });

  it('reaches exactly zero from any release speed in finite steps', () => {
    let v = { vx: 40, vy: -25 };
    let steps = 0;
    while ((v.vx !== 0 || v.vy !== 0) && steps < 1000) {
      v = decayVelocity(v.vx, v.vy);
      steps++;
    }
    expect(v).toEqual({ vx: 0, vy: 0 });
    expect(steps).toBeLessThan(1000);
  });
});
