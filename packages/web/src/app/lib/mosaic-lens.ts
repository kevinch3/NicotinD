import type { PackedTile } from './mosaic-packing';

/**
 * The wide-angle lens: a logarithmic fisheye over the tile plane.
 *
 * The centre is magnified and the field compresses toward a rim (see
 * FISHEYE_K), so tiles grow as they near the middle and bunch up and shrink
 * toward the edge instead of marching off it at constant size. The rim sits
 * where the original orthographic projection put it (R·sin THETA_MAX on
 * screen, R·THETA_MAX on the plane); past it tiles are culled.
 *
 * Pure and DOM-free: given a camera and a viewport it returns where every
 * visible tile copy goes. The component just writes transforms.
 */

/** Widest visible angle, radians. Beyond this the plane has curved out of view. */
export const THETA_MAX = 1.15;

/**
 * The fisheye (#1638). Inside the rim above, the radial profile is
 * logarithmic: at u = r / (R·THETA_MAX) the screen radius is
 * R·sin(THETA_MAX) · ln(1 + K·u) / ln(1 + K), and a tile's scale is that
 * curve's slope, so magnification falls as 1/(1 + K·u) — large at the centre,
 * dropping fast and then gently. Scaling by the slope, not the radius ratio,
 * is what keeps radial neighbours from running into each other. The outer
 * radius is the orthographic lens's, so the visible field and the rim blur's
 * circle are unchanged. K sets the strength: 3.5 gives ~1.85× at the centre
 * and leaves the rim at the old cos(THETA_MAX) ≈ 0.41.
 */
export const FISHEYE_K = 3.5;
/** Screen radius of the rim per unit of plane radius, R·sin θmax / (R·θmax). */
const RIM_RATIO = Math.sin(THETA_MAX) / THETA_MAX;
const LN_1K = Math.log(1 + FISHEYE_K);
/** Magnification at the dead centre. */
export const CENTER_SCALE = (RIM_RATIO * FISHEYE_K) / LN_1K;
/** Magnification at the rim. */
export const RIM_SCALE = CENTER_SCALE / (1 + FISHEYE_K);
/**
 * Tiles are packed this much smaller than `tileSize` says. The fisheye
 * magnifies the gaps along with the tiles, so packing at full size left a
 * magnified, sparse field; packed smaller, the centre tile lands at about
 * 1.1× its pre-fisheye size and everything outside it is denser.
 */
export const TILE_BASE = 1.1 / CENTER_SCALE;
/** Opacity fades over the outer this-much of the lens radius. */
export const FADE_BAND = 0.45;

/** Per-frame velocity decay after release. */
export const FRICTION = 0.94;
/** Squared speed below which the camera snaps to a dead stop. */
export const REST_EPSILON = 0.0025;

/**
 * One inertia step: friction, then a hard snap to zero below the rest
 * threshold. The snap matters — exponential decay alone never reaches zero, so
 * the mosaic would creep sub-pixel forever, which reads as "it never stops"
 * rather than "it is alive". A resting mosaic is genuinely at rest.
 */
export function decayVelocity(vx: number, vy: number): { vx: number; vy: number } {
  const nvx = vx * FRICTION;
  const nvy = vy * FRICTION;
  if (nvx * nvx + nvy * nvy < REST_EPSILON) return { vx: 0, vy: 0 };
  return { vx: nvx, vy: nvy };
}

const LUT_SIZE = 2048;
/** Scale by u: the slope of the log curve. */
const SCALE_LUT = new Float32Array(LUT_SIZE + 1);
/** Screen radius by u, as a fraction of the rim's screen radius. */
const RADIUS_LUT = new Float32Array(LUT_SIZE + 1);
for (let i = 0; i <= LUT_SIZE; i++) {
  const u = i / LUT_SIZE;
  SCALE_LUT[i] = CENTER_SCALE / (1 + FISHEYE_K * u);
  RADIUS_LUT[i] = Math.log(1 + FISHEYE_K * u) / LN_1K;
}

export interface Placement {
  /** Pool key: one packed tile can be on screen several times, once per torus copy. */
  key: string;
  packed: PackedTile;
  /** Which torus copy this is — the discovery cells key their content on it. */
  i: number;
  j: number;
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
  const rimRadius = lensRadius * Math.sin(THETA_MAX);
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
        const u = r / limit;
        const k = (u * LUT_SIZE) | 0;
        const scale = SCALE_LUT[k];
        // At r = 0 the tile is dead centre; ρ / r tends to the centre scale,
        // but the division is undefined, so place it at the centre explicitly.
        const f = r ? (rimRadius * RADIUS_LUT[k]) / r : 0;
        const sx = halfW + dx * f;
        const sy = halfH + dy * f;
        // Cull on the drawn size: a magnified tile still reaches the screen
        // from further out than its packed half-size would say.
        const reach = t.half * scale;
        if (sx < -reach || sx > view.w + reach || sy < -reach || sy > view.h + reach) continue;

        out.push({
          key: `${t.id}_${i}_${j}`,
          packed: t,
          i,
          j,
          left: sx - t.half,
          top: sy - t.half,
          scale,
          opacity: u > 1 - FADE_BAND ? Math.max(0, (1 - u) / FADE_BAND) : 1,
        });
      }
    }
  }
  return out;
}

/**
 * How far a drag must travel, in screen px, before the playing tile lets go of
 * the field (#1638). A share of the stage's shorter side, so the detent feels
 * the same on a phone and a desktop, and larger for touch than for a mouse or
 * pen: a thumb wobbles and sweeps further than a wrist. Clamped so a tiny or a
 * huge stage still gets a detent you can feel and escape.
 */
export function lockBreakPx(stageMin: number, pointerType: string | undefined): number {
  const share = pointerType === 'touch' ? 0.14 : 0.09;
  return Math.min(140, Math.max(40, stageMin * share));
}
