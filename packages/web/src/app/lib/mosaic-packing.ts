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
/**
 * Positions weighed per tile before it lands (Mitchell's best-candidate): of
 * the first few that fit, take the one farthest from its nearest neighbour.
 *
 * This is what separates an *even* field from a merely random one. First-fit
 * over a shuffled scan has no preferred region — but random points clump, and
 * a clump reads as a blob with a hole beside it, which is the artefact this
 * whole ordering exists to avoid.
 */
export const CANDIDATE_SAMPLES = 12;
/**
 * Positions scanned per tile once at least one fit is known. Without a bound,
 * a late tile in a nearly-full patch walks the whole candidate list looking
 * for a twelfth fit that may not exist.
 */
export const MAX_SCAN = 4000;

/**
 * Deterministic rank for a candidate position — the scan order.
 *
 * The ordering used to be centre-out, which is what made the field visibly
 * repeat: first-fit from the middle packs an inscribed *disc* and leaves the
 * square patch's corners empty, so tiling the patch merged four empty corners
 * into one void every W pixels. **A torus has no centre**, so the packing must
 * not have one either. A hash gives a fixed, centre-free permutation — fixed
 * because a tile must not move between reloads.
 */
function positionRank(x: number, y: number): number {
  let h = Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

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
 * Place tiles largest-and-smallest alternating, each at the best-spaced free
 * position found in a centre-free scan.
 *
 * The alternation keeps sizes mixed across the patch, so the field reads as a
 * mosaic rather than as bands of one size. The *positions* come from a hashed
 * permutation scored by `CANDIDATE_SAMPLES` best-candidate — see
 * `positionRank` for why the old centre-out ordering made the plane repeat.
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

  // Largest first. The old alternation existed to stop big tiles clumping in
  // the middle, which was an artefact of the centre-out scan; the spacing rule
  // now spreads them by construction. Order therefore serves packing instead:
  // a big tile needs a big gap, and gaps only shrink as the patch fills, so
  // taking the biggest first is what keeps every tile placeable. Interleaving
  // sizes here strands the largest tiles and silently drops them.
  const order = [...tiles].sort((a, b) => sizeOf(b) - sizeOf(a));

  // Candidate positions in a fixed, centre-free permutation.
  const candidates: Array<[number, number]> = [];
  for (let y = 0; y < W; y += STEP) for (let x = 0; x < W; x += STEP) candidates.push([x, y]);
  candidates.sort((a, b) => positionRank(a[0], a[1]) - positionRank(b[0], b[1]));

  /** Squared wrapped distance to the nearest placed tile, capped at one cell. */
  const nearestSq = (x: number, y: number): number => {
    let best = CELL * CELL;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const bucket = hash.get(hashKey(x + i * CELL, y + j * CELL));
        if (!bucket) continue;
        for (const t of bucket) {
          const dx = wrapDelta(x - t.x, W);
          const dy = wrapDelta(y - t.y, W);
          const d = dx * dx + dy * dy;
          if (d < best) best = d;
        }
      }
    }
    return best;
  };

  for (let n = 0; n < order.length; n++) {
    const tile = order[n];
    const size = sizeOf(tile);
    let bestX = -1;
    let bestY = -1;
    let bestSpacing = -1;
    let found = 0;
    // Each tile enters the permutation at its own offset, so the early tiles
    // do not all contend for the same head of the list.
    const start = (n * 7919) % candidates.length;
    for (let k = 0; k < candidates.length; k++) {
      if (found > 0 && k > MAX_SCAN) break;
      const [x, y] = candidates[(start + k) % candidates.length];
      if (!fits(x, y, size)) continue;
      const spacing = nearestSq(x, y);
      if (spacing > bestSpacing) {
        bestSpacing = spacing;
        bestX = x;
        bestY = y;
      }
      if (++found >= CANDIDATE_SAMPLES) break;
    }
    // Nothing anywhere in the patch fits this tile; drop it rather than overlap.
    if (bestX < 0) continue;

    const p: PackedTile = { tile, id: packed.length, x: bestX, y: bestY, size, half: size / 2 };
    packed.push(p);
    const key = hashKey(bestX, bestY);
    const bucket = hash.get(key);
    if (bucket) bucket.push(p);
    else hash.set(key, [p]);
  }

  return { tiles: packed, W };
}
