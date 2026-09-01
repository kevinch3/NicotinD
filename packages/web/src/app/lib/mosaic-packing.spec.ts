import { describe, expect, it } from 'vitest';
import {
  GAP,
  cellCount,
  packMosaic,
  patchSide,
  wrapDelta,
  type PackedTile,
} from './mosaic-packing';
import type { MosaicTile } from './mosaic-tiles';

const tile = (key: string, score: number): MosaicTile => ({
  key,
  kind: 'song',
  title: key,
  subtitle: '',
  score,
  action: { type: 'song', track: { id: key, title: key, artist: 'A' } },
});

const tiles = (n: number): MosaicTile[] =>
  Array.from({ length: n }, (_, i) => tile(`song:${i}`, ((i * 37) % 100) / 100));

const sizeOf = (t: MosaicTile): number => Math.round(90 + t.score * 150);

describe('wrapDelta', () => {
  it('takes the short way round the ring', () => {
    expect(wrapDelta(90, 100)).toBe(-10);
    expect(wrapDelta(10, 100)).toBe(10);
    expect(wrapDelta(-90, 100)).toBe(10);
  });
});

describe('patchSide', () => {
  it('grows with the number of tiles', () => {
    expect(patchSide(tiles(80).map(sizeOf))).toBeGreaterThan(patchSide(tiles(20).map(sizeOf)));
  });

  // A fixed side tuned for ~80 tiles leaves a small library packed into one
  // corner with a lot of nothing to pan through.
  it('stays at least three max-tiles wide, so a tile cannot wrap into itself', () => {
    const sizes = [240];
    expect(patchSide(sizes)).toBeGreaterThanOrEqual(3 * (240 + GAP));
  });
});

describe('cellCount', () => {
  // The collision test only inspects the 3x3 cell neighbourhood, which is sound
  // only while one cell is at least a max tile plus the gap.
  it('never produces a cell smaller than one max tile plus the gap', () => {
    for (const n of [4, 12, 40, 120]) {
      const sizes = tiles(n).map(sizeOf);
      const W = patchSide(sizes);
      const maxSize = Math.max(...sizes);
      const cell = W / cellCount(W, maxSize);
      expect(cell).toBeGreaterThanOrEqual(maxSize + GAP);
    }
  });

  it('clamps to one cell rather than zero for a tiny patch', () => {
    expect(cellCount(50, 240)).toBe(1);
  });
});

/** Which blocks of a 3x3 grid over the patch the `n` biggest tiles land in. */
const blocksTouchedByBiggest = (packed: PackedTile[], W: number, n: number): number => {
  const big = [...packed].sort((a, b) => b.size - a.size).slice(0, n);
  const block = (v: number): number => Math.min(2, Math.floor((v / W) * 3));
  return new Set(big.map((p) => `${block(p.x)},${block(p.y)}`)).size;
};

/**
 * Widest run of vertical strips containing no tile at all, measured around the
 * wrap. This is the seam itself: an empty channel repeats every W pixels, and
 * the eye reads the repetition as "one patch ending and another starting".
 */
const widestEmptyBand = (packed: PackedTile[], W: number): number => {
  const STRIP = 10;
  const strips = Math.ceil(W / STRIP);
  const occupied = new Array<boolean>(strips).fill(false);
  for (const p of packed) {
    for (let s = Math.floor((p.x - p.half) / STRIP); s <= Math.ceil((p.x + p.half) / STRIP); s++) {
      occupied[((s % strips) + strips) % strips] = true;
    }
  }
  let worst = 0;
  let run = 0;
  // Twice around, so a band straddling the wrap is measured whole.
  for (let i = 0; i < strips * 2; i++) {
    if (occupied[i % strips]) run = 0;
    else worst = Math.max(worst, Math.min(++run, strips));
  }
  return worst * STRIP;
};

describe('packMosaic', () => {
  // Spreading tiles evenly fragments the free space, so a big tile placed late
  // can find nowhere to go — which the packer resolves by silently dropping it.
  // Ordering largest-first is what prevents that, and only a spread of counts
  // catches it: 40 tiles placed fine while 81 lost seven.
  it.each([1, 8, 40, 81, 120])('places every one of %i tiles', (n) => {
    expect(packMosaic(tiles(n), sizeOf).tiles).toHaveLength(n);
  });

  /**
   * The property that matters, and the one a naive Euclidean check misses: the
   * patch repeats, so a tile near the right edge is a NEIGHBOUR of one near the
   * left edge. Overlap must be tested with wrapped distance in both axes.
   */
  it('leaves no two tiles overlapping, including across the torus seam', () => {
    for (const n of [8, 40, 90]) {
      const { tiles: packed, W } = packMosaic(tiles(n), sizeOf);
      for (let i = 0; i < packed.length; i++) {
        for (let j = i + 1; j < packed.length; j++) {
          const a = packed[i];
          const b = packed[j];
          const need = (a.size + b.size) / 2 + GAP;
          const dx = Math.abs(wrapDelta(a.x - b.x, W));
          const dy = Math.abs(wrapDelta(a.y - b.y, W));
          expect(
            dx >= need || dy >= need,
            `tiles ${i} and ${j} overlap across the seam (dx=${dx}, dy=${dy}, need=${need})`,
          ).toBe(true);
        }
      }
    }
  });

  it('keeps every tile inside the patch', () => {
    const { tiles: packed, W } = packMosaic(tiles(30), sizeOf);
    for (const p of packed) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThan(W);
      expect(p.y).toBeLessThan(W);
    }
  });

  /**
   * The patch tiles the plane, so any region the packing systematically avoids
   * repeats as a visible seam. These two assert the field is actually
   * continuous — the property the surface is built on.
   *
   * Both were written against the centre-out packing they replaced, which
   * filled an inscribed disc: it left **zero** tiles outside that disc at every
   * tile count, and channels 30-120px wide. Neither number was close.
   */
  it.each([40, 81, 120])(
    'fills the patch corners rather than an inscribed disc (%i tiles)',
    (n) => {
      const { tiles: packed, W } = packMosaic(tiles(n), sizeOf);
      const c = W / 2;
      const corners = packed.filter((p) => Math.hypot(p.x - c, p.y - c) > c).length;
      expect(corners).toBeGreaterThan(0);
    },
  );

  it.each([40, 81, 120])('leaves no empty channel across the patch (%i tiles)', (n) => {
    const { tiles: packed, W } = packMosaic(tiles(n), sizeOf);
    expect(widestEmptyBand(packed, W)).toBe(0);
  });

  /**
   * Replaces a test that asserted the placement *order* interleaved sizes — a
   * mechanism, not the property. It passed happily while the old packer put all
   * eight of its biggest tiles into a SINGLE block of nine at 120 tiles. The
   * spacing rule is what spreads them now, so assert position instead.
   */
  it.each([40, 81, 120])('spreads the largest tiles across the patch (%i tiles)', (n) => {
    const { tiles: packed, W } = packMosaic(tiles(n), sizeOf);
    expect(blocksTouchedByBiggest(packed, W, 8)).toBeGreaterThanOrEqual(5);
  });

  it('handles an empty and a single-tile set', () => {
    expect(packMosaic([], sizeOf).tiles).toHaveLength(0);
    expect(packMosaic([tile('song:solo', 0.5)], sizeOf).tiles).toHaveLength(1);
  });

  it('is deterministic', () => {
    const a = packMosaic(tiles(20), sizeOf);
    const b = packMosaic(tiles(20), sizeOf);
    expect(a.tiles.map((t) => [t.tile.key, t.x, t.y])).toEqual(
      b.tiles.map((t) => [t.tile.key, t.x, t.y]),
    );
  });
});
