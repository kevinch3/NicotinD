/**
 * Pure scene for the karaoke VFX (issue #643): six band levels → six glowing
 * orbs. DI/DOM-free so the composition is unit-tested; the component only
 * paints the result. Deterministic in (levels, t, size) — no randomness, so
 * every device draws the same frame for the same moment of the track.
 *
 * Layout is by musical role, not by band index: the two bass bands sit low
 * and central and are the largest (a drop should feel like weight), mids
 * flank them, highs are small and float near the top. Everything drifts on
 * slow sines of `t` so a sustained level still breathes.
 */

export interface VfxShape {
  /** Band index 0..5 (sub_bass … high) — the painter picks a colour from it. */
  band: number;
  x: number;
  y: number;
  radius: number;
  /** 0..1 */
  alpha: number;
}

/** Anchor (x, y) as canvas fractions, and the orb's size weight. */
const LAYOUT: { x: number; y: number; size: number; speed: number }[] = [
  { x: 0.5, y: 0.64, size: 1.0, speed: 0.21 }, // sub_bass
  { x: 0.5, y: 0.5, size: 0.85, speed: 0.27 }, // bass
  { x: 0.26, y: 0.46, size: 0.55, speed: 0.33 }, // low_mid
  { x: 0.74, y: 0.46, size: 0.55, speed: 0.31 }, // mid
  { x: 0.36, y: 0.24, size: 0.32, speed: 0.47 }, // high_mid
  { x: 0.66, y: 0.2, size: 0.28, speed: 0.53 }, // high
];

const DRIFT_X = 0.045;
const DRIFT_Y = 0.035;
/** Radius at silence, as a fraction of the canvas' short edge — never 0. */
const MIN_RADIUS = 0.03;
const MAX_RADIUS = 0.34;
const MIN_ALPHA = 0.06;
const MAX_ALPHA = 0.8;

export function vfxShapes(levels: number[], t: number, width: number, height: number): VfxShape[] {
  const short = Math.max(1, Math.min(width, height));
  return LAYOUT.map((l, band) => {
    const level = Math.max(0, Math.min(1, levels[band] ?? 0));
    const dx = Math.sin(t * l.speed * 2 * Math.PI + band) * DRIFT_X;
    const dy = Math.cos(t * l.speed * 1.3 * 2 * Math.PI + band * 1.7) * DRIFT_Y;
    const x = Math.min(width, Math.max(0, (l.x + dx) * width));
    const y = Math.min(height, Math.max(0, (l.y + dy) * height));
    const radius = short * l.size * (MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * level);
    const alpha = MIN_ALPHA + (MAX_ALPHA - MIN_ALPHA) * level;
    return { band, x, y, radius, alpha };
  });
}
