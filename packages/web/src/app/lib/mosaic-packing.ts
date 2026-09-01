import type { MosaicTile } from './mosaic-tiles';

/**
 * Pack tiles into a square patch that tiles the plane seamlessly — a torus.
 *
 * Panning never runs out of content because the patch repeats: the renderer
 * draws copies at `x + i*W, y + j*W`. That only works if collisions are tested
 * with WRAPPED distance, so a tile near the right edge knows about a tile near
 * the left edge — they are neighbours once the patch repeats.
 *
 * Runs once per data load, never per frame.
 */

/** Minimum clear space between two tile boxes, in patch units. */
export const GAP = 14;
/** Candidate-position grid. Finer = tighter packing, quadratically more work. */
export const STEP = 8;
/**
 * Fraction of the patch covered by tiles. Above ~0.6 the first-fit scan starts
 * failing to place the last (smallest) tiles; below ~0.4 the mosaic reads as
 * sparse. 0.5 keeps it dense without dropping tiles.
 */
export const DENSITY = 0.5;

export interface PackedTile {
  tile: MosaicTile;
  /** Index into the packed array — the renderer's pool key prefix. */
  id: number;
  x: number;
  y: number;
  size: number;
  half: number;
}

export interface Packing {
  tiles: PackedTile[];
  /** Patch side. The plane repeats every W in both axes. */
  W: number;
}

/** Signed distance on a ring of circumference L — the short way round. */
export function wrapDelta(d: number, L: number): number {
  const m = ((d % L) + L) % L;
  return m > L / 2 ? m - L : m;
}

/**
 * Patch side for a set of tile sizes.
 *
 * Derived, not fixed: a hardcoded side tuned for ~80 tiles leaves a 12-tile
 * library packed into one corner with vast emptiness to pan through, and a
 * 300-tile one unable to place everything. The floor keeps the patch at least
 * three max-tiles wide, below which a tile can wrap into itself.
 */
export function patchSide(sizes: readonly number[]): number {
  const area = sizes.reduce((a, s) => a + s * s, 0);
  const maxSize = sizes.reduce((m, s) => Math.max(m, s), 0);
  return Math.max(Math.ceil(Math.sqrt(area / DENSITY)), 3 * (maxSize + GAP));
}

/**
 * Cells per axis for the collision hash.
 *
 * The `fits` test only inspects the 3×3 cell neighbourhood, which is sound only
 * while one cell is at least a max tile plus the gap — otherwise a colliding
 * tile can sit two cells away and go unseen. The original fixed `NC = 5` held
 * only by coincidence for one particular tile-size range.
 */
export function cellCount(W: number, maxSize: number): number {
  return Math.max(1, Math.floor(W / (maxSize + GAP)));
}

/**
 * Place tiles largest-and-smallest alternating, each at the free position
 * nearest the patch centre.
 *
 * The alternation matters: placing strictly largest-first clumps every big tile
 * in the middle and rings it with small ones. Interleaving keeps sizes mixed
 * across the whole patch, which is what makes the field read as a mosaic rather
 * than a target.
 */
export function packMosaic(
  tiles: readonly MosaicTile[],
  sizeOf: (t: MosaicTile) => number,
): Packing {
  const sizes = tiles.map(sizeOf);
  const W = patchSide(sizes);
  const maxSize = sizes.reduce((m, s) => Math.max(m, s), 0);
  const NC = cellCount(W, maxSize);
  const CELL = W / NC;

  const cellOf = (v: number): number => ((Math.floor(v / CELL) % NC) + NC) % NC;
  const hashKey = (x: number, y: number): string => `${cellOf(x)},${cellOf(y)}`;

  const hash = new Map<string, PackedTile[]>();
  const packed: PackedTile[] = [];

  const fits = (x: number, y: number, size: number): boolean => {
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const bucket = hash.get(hashKey(x + i * CELL, y + j * CELL));
        if (!bucket) continue;
        for (const t of bucket) {
          const need = (size + t.size) / 2 + GAP;
          if (Math.abs(wrapDelta(x - t.x, W)) < need && Math.abs(wrapDelta(y - t.y, W)) < need) {
            return false;
          }
        }
      }
    }
    return true;
  };

  // Alternate biggest, smallest, second-biggest, second-smallest, …
  const bySize = [...tiles].sort((a, b) => sizeOf(b) - sizeOf(a));
  const order: MosaicTile[] = [];
  let lo = 0;
  let hi = bySize.length - 1;
  while (lo <= hi) {
    order.push(bySize[hi--]);
    if (lo <= hi) order.push(bySize[lo++]);
  }

  // Candidate positions, centre-out, so the patch fills from the middle.
  const candidates: Array<[number, number]> = [];
  for (let y = 0; y < W; y += STEP) for (let x = 0; x < W; x += STEP) candidates.push([x, y]);
  const c = W / 2;
  candidates.sort((a, b) => Math.hypot(a[0] - c, a[1] - c) - Math.hypot(b[0] - c, b[1] - c));

  for (const tile of order) {
    const size = sizeOf(tile);
    for (const [x, y] of candidates) {
      if (!fits(x, y, size)) continue;
      const p: PackedTile = { tile, id: packed.length, x, y, size, half: size / 2 };
      packed.push(p);
      const k = hashKey(x, y);
      const bucket = hash.get(k);
      if (bucket) bucket.push(p);
      else hash.set(k, [p]);
      break;
    }
  }

  return { tiles: packed, W };
}
