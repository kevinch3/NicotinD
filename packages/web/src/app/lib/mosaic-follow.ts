import type { PackedTile } from './mosaic-packing';
import type { Placement } from './mosaic-lens';

/**
 * Where the next song lands on the mosaic (docs/mosaic-follows-playback.md):
 * a knight's move from the tile that is playing — two steps one way, one the
 * other, never a straight line — onto whichever tile copy sits nearest that
 * point. Pure and DOM-free; the component owns the face swap and the camera.
 */

/** The eight knight's moves, in steps. */
export const KNIGHT_MOVES: ReadonlyArray<readonly [number, number]> = [
  [1, 2],
  [2, 1],
  [2, -1],
  [1, -2],
  [-1, -2],
  [-2, -1],
  [-2, 1],
  [-1, 2],
];

/** Below this opacity a copy is fading out at the rim, and counts as off screen. */
export const ON_SCREEN_OPACITY = 0.5;

/** One copy of one packed tile on the plane: which tile, which torus copy, where. */
export interface PlaneSpot {
  id: number;
  i: number;
  j: number;
  x: number;
  y: number;
}

/** The same key `visiblePlacements` gives the copy. */
export const spotKey = (s: Pick<PlaneSpot, 'id' | 'i' | 'j'>): string => `${s.id}_${s.i}_${s.j}`;

export function spotOf(p: PackedTile, i: number, j: number, W: number): PlaneSpot {
  return { id: p.id, i, j, x: p.x + i * W, y: p.y + j * W };
}

/** The copy of a packed tile nearest a plane point. */
function nearestCopy(p: PackedTile, x: number, y: number, W: number): PlaneSpot {
  return spotOf(p, Math.round((x - p.x) / W), Math.round((y - p.y) / W), W);
}

/** The tile copy, of any packed tile, whose centre is nearest a plane point. */
export function nearestSpot(
  packed: readonly PackedTile[],
  W: number,
  x: number,
  y: number,
): PlaneSpot | null {
  let best: PlaneSpot | null = null;
  let bestSq = Infinity;
  for (const p of packed) {
    const c = nearestCopy(p, x, y, W);
    const d = (c.x - x) ** 2 + (c.y - y) ** 2;
    if (d < bestSq) {
      bestSq = d;
      best = c;
    }
  }
  return best;
}

/**
 * One step, in plane px: the median tile side plus the packer's gap. The median
 * rather than the playing tile's own side, so one large tile does not throw the
 * next song across the field.
 */
export function medianStep(packed: readonly Pick<PackedTile, 'size'>[], gap: number): number {
  const sizes = packed.map((p) => p.size).sort((a, b) => a - b);
  return (sizes[sizes.length >> 1] ?? 0) + gap;
}

/**
 * The tile the next song takes. The direction is random (`rand` in [0, 1));
 * a move whose nearest tile is the playing one, or one this radio already
 * visited, gives way to the next move round. Only when all eight are spent does
 * it revisit, so a long radio never stalls.
 */
export function knightStep(
  packed: readonly PackedTile[],
  W: number,
  from: PlaneSpot,
  step: number,
  rand: () => number,
  visited: ReadonlySet<string>,
): PlaneSpot | null {
  if (packed.length === 0 || W <= 0) return null;
  const start = Math.floor(rand() * KNIGHT_MOVES.length);
  const self = spotKey(from);
  let fallback: PlaneSpot | null = null;
  for (let n = 0; n < KNIGHT_MOVES.length; n++) {
    const [mx, my] = KNIGHT_MOVES[(start + n) % KNIGHT_MOVES.length];
    const best = nearestSpot(packed, W, from.x + mx * step, from.y + my * step);
    if (!best || spotKey(best) === self) continue;
    if (!visited.has(spotKey(best))) return best;
    fallback ??= best;
  }
  return fallback;
}

/** The playing copy is on screen: drawn this frame, and not fading at the rim. */
export function spotOnScreen(placements: readonly Placement[], spot: PlaneSpot): boolean {
  const key = spotKey(spot);
  return placements.some((p) => p.key === key && p.opacity >= ON_SCREEN_OPACITY);
}
