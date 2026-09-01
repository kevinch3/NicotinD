import type { PackedTile } from './mosaic-packing';

/**
 * The wide-angle lens: an orthographic azimuthal projection of the tile plane.
 *
 * Distance from the camera becomes an angle (θ = r / R), so the plane curves
 * away like a globe seen from outside. A tile's screen radius is R·sin θ and its
 * scale is cos θ — which means tiles bunch up and shrink toward the rim instead
 * of marching off the edge at constant size. Past THETA_MAX the surface has
 * turned far enough away to be culled.
 *
 * Pure and DOM-free: given a camera and a viewport it returns where every
 * visible tile copy goes. The component just writes transforms.
 */

/** Widest visible angle, radians. Beyond this the plane has curved out of view. */
export const THETA_MAX = 1.15;
/** cos(THETA_MAX) — the scale at the rim. */
export const COS_MAX = Math.cos(THETA_MAX);
/** Opacity fades over the last this-much of the cosine range. */
export const FADE_BAND = 0.4;

const LUT_SIZE = 2048;
const COS_LUT = new Float32Array(LUT_SIZE + 1);
const SIN_LUT = new Float32Array(LUT_SIZE + 1);
for (let i = 0; i <= LUT_SIZE; i++) {
  const th = (THETA_MAX * i) / LUT_SIZE;
  COS_LUT[i] = Math.cos(th);
  SIN_LUT[i] = Math.sin(th);
}

export interface Placement {
  /** Pool key: one packed tile can be on screen several times, once per torus copy. */
  key: string;
  packed: PackedTile;
  /** Top-left in stage pixels (the tile's own transform origin). */
  left: number;
  top: number;
  scale: number;
  opacity: number;
}

export interface Camera {
  x: number;
  y: number;
}

export interface Viewport {
  w: number;
  h: number;
}

/**
 * Every visible copy of every tile, for one frame.
 *
 * The i/j loops walk the torus copies that could reach the lens at all; the
 * radius test culls the corners the square bound lets through.
 */
export function visiblePlacements(
  packed: readonly PackedTile[],
  cam: Camera,
  view: Viewport,
  W: number,
  lensRadius: number,
): Placement[] {
  const out: Placement[] = [];
  const halfW = view.w / 2;
  const halfH = view.h / 2;
  const limit = lensRadius * THETA_MAX;
  const limitSq = limit * limit;

  const i0 = Math.floor((cam.x - limit) / W);
  const i1 = Math.floor((cam.x + limit) / W);
  const j0 = Math.floor((cam.y - limit) / W);
  const j1 = Math.floor((cam.y + limit) / W);

  for (const t of packed) {
    for (let i = i0; i <= i1; i++) {
      const dx = t.x + i * W - cam.x;
      if (dx > limit || dx < -limit) continue;
      for (let j = j0; j <= j1; j++) {
        const dy = t.y + j * W - cam.y;
        if (dy > limit || dy < -limit) continue;
        const rSq = dx * dx + dy * dy;
        if (rSq > limitSq) continue;

        const r = Math.sqrt(rSq);
        const k = ((r / lensRadius / THETA_MAX) * LUT_SIZE) | 0;
        const cos = COS_LUT[k];
        // At r = 0 the tile is dead centre; sin θ / r is 1/R in the limit, but
        // the division is undefined, so place it at the centre explicitly.
        const f = r ? (lensRadius * SIN_LUT[k]) / r : 0;
        const sx = halfW + dx * f;
        const sy = halfH + dy * f;
        if (sx < -t.half || sx > view.w + t.half || sy < -t.half || sy > view.h + t.half) continue;

        out.push({
          key: `${t.id}_${i}_${j}`,
          packed: t,
          left: sx - t.half,
          top: sy - t.half,
          scale: cos,
          opacity: cos < COS_MAX + FADE_BAND ? Math.max(0, (cos - COS_MAX) / FADE_BAND) : 1,
        });
      }
    }
  }
  return out;
}
