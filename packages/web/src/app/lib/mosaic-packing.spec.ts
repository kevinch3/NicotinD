import { describe, expect, it } from 'vitest';
import { GAP, cellCount, packMosaic, patchSide, wrapDelta } from './mosaic-packing';
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

describe('packMosaic', () => {
  it('places every tile', () => {
    const list = tiles(40);
    expect(packMosaic(list, sizeOf).tiles).toHaveLength(40);
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

  it('mixes sizes rather than clumping the big tiles in the middle', () => {
    // Alternating placement order is what prevents a bullseye: the largest and
    // smallest tiles are both placed early, near the centre.
    const { tiles: packed } = packMosaic(tiles(40), sizeOf);
    const first = packed.slice(0, 6).map((p) => p.size);
    expect(Math.max(...first) - Math.min(...first)).toBeGreaterThan(40);
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
