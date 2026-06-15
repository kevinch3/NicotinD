import { describe, it, expect } from 'vitest';
import { clampMenuPosition } from './menu-position';

describe('clampMenuPosition', () => {
  const VW = 412;
  const VH = 915;

  it('leaves a position that already fits unchanged', () => {
    expect(clampMenuPosition({ x: 50, y: 100 }, VW, VH)).toEqual({ x: 50, y: 100 });
  });

  it('pulls a right-edge tap back so the menu fits (§G6)', () => {
    // tap near the right edge → x clamped to vw - menuW - margin = 412-200-8 = 204
    expect(clampMenuPosition({ x: 400, y: 100 }, VW, VH).x).toBe(204);
  });

  it('pulls a bottom-edge tap up so the menu fits', () => {
    // y clamped to vh - menuH - margin = 915-96-8 = 811
    expect(clampMenuPosition({ x: 50, y: 900 }, VW, VH).y).toBe(811);
  });

  it('never goes past the top-left margin', () => {
    expect(clampMenuPosition({ x: -50, y: -50 }, VW, VH)).toEqual({ x: 8, y: 8 });
  });

  it('respects a custom menu size', () => {
    expect(clampMenuPosition({ x: 400, y: 100 }, VW, VH, 100).x).toBe(412 - 100 - 8);
  });
});
