import { describe, expect, it } from 'vitest';
import {
  KNIGHT_MOVES,
  knightStep,
  medianStep,
  nearestSpot,
  spotKey,
  spotOf,
  spotOnScreen,
  type PlaneSpot,
} from './mosaic-follow';
import type { PackedTile } from './mosaic-packing';
import type { Placement } from './mosaic-lens';

/** A 6×6 grid of 40px tiles, 50px apart, in a 300px patch. */
const W = 300;
const grid: PackedTile[] = Array.from({ length: 36 }, (_, n) => {
  const x = 25 + (n % 6) * 50;
  const y = 25 + Math.floor(n / 6) * 50;
  return {
    id: n,
    x,
    y,
    size: 40,
    half: 20,
    tile: {
      key: `t${n}`,
      kind: 'song',
      title: '',
      subtitle: '',
      score: 0,
      action: { type: 'route', path: '/' },
    },
  } as PackedTile;
});
const at = (id: number, i = 0, j = 0): PlaneSpot => spotOf(grid[id], i, j, W);
const seq = (...values: number[]) => {
  let k = 0;
  return () => values[k++ % values.length];
};

describe('knightStep', () => {
  it('lands two steps one way and one the other', () => {
    const from = at(14); // (125, 125)
    for (let m = 0; m < KNIGHT_MOVES.length; m++) {
      const to = knightStep(grid, W, from, 50, seq(m / KNIGHT_MOVES.length), new Set());
      expect(to).not.toBeNull();
      const [dx, dy] = KNIGHT_MOVES[m];
      expect(to!.x - from.x).toBe(dx * 50);
      expect(to!.y - from.y).toBe(dy * 50);
    }
  });

  it('is never a straight line: both axes move, and one of them by two steps', () => {
    for (const [dx, dy] of KNIGHT_MOVES) {
      expect(dx * dy).not.toBe(0);
      expect(Math.max(Math.abs(dx), Math.abs(dy))).toBe(2);
    }
  });

  it('crosses into the neighbouring torus copy instead of stopping at the patch edge', () => {
    const from = at(5); // (275, 25): the patch's top-right tile
    const to = knightStep(grid, W, from, 50, seq(1 / 8), new Set()); // move [2, 1]
    expect(to).toMatchObject({ id: 1 + 6, i: 1, j: 0, x: 375, y: 75 });
  });

  it('skips a landing the radio already visited and takes the next move round', () => {
    const from = at(14);
    const first = knightStep(grid, W, from, 50, seq(0), new Set())!;
    const second = knightStep(grid, W, from, 50, seq(0), new Set([spotKey(first)]))!;
    expect(spotKey(second)).not.toBe(spotKey(first));
    expect(second.x - from.x).toBe(KNIGHT_MOVES[1][0] * 50);
  });

  it('revisits rather than stalls when every move has been used', () => {
    const from = at(14);
    const all = new Set(
      KNIGHT_MOVES.map((_, m) => spotKey(knightStep(grid, W, from, 50, seq(m / 8), new Set())!)),
    );
    const to = knightStep(grid, W, from, 50, seq(0), all);
    expect(to).not.toBeNull();
    expect(spotKey(to!)).not.toBe(spotKey(from));
  });

  it('snaps to the nearest tile when no tile sits exactly on the move', () => {
    const to = knightStep(grid, W, at(14), 47, seq(0), new Set())!; // lands at (172, 219)
    expect(to).toMatchObject({ x: 175, y: 225 });
  });

  it('has nowhere to go on an empty field', () => {
    expect(knightStep([], W, at(0), 50, seq(0), new Set())).toBeNull();
  });
});

describe('medianStep', () => {
  it('is the median tile side plus the gap between tiles', () => {
    const sizes = [10, 40, 40, 90].map((size) => ({ ...grid[0], size }));
    expect(medianStep(sizes, 14)).toBe(54);
  });
});

describe('spotOnScreen', () => {
  const placement = (key: string, opacity: number) => ({ key, opacity }) as Placement;
  it('counts the playing copy only while it is drawn and not fading at the rim', () => {
    const spot = at(3, 1, -1);
    expect(spotOnScreen([placement('3_1_-1', 1)], spot)).toBe(true);
    expect(spotOnScreen([placement('3_1_-1', 0.2)], spot)).toBe(false);
    expect(spotOnScreen([placement('3_0_0', 1)], spot)).toBe(false);
    expect(spotOnScreen([], spot)).toBe(false);
  });
});

describe('nearestSpot', () => {
  it('finds the copy a plane point sits on, in whichever torus copy it is', () => {
    expect(nearestSpot(grid, W, 25 + 300, 75 - 600)).toMatchObject({ id: 6, i: 1, j: -2 });
    expect(nearestSpot([], W, 0, 0)).toBeNull();
  });
});
