import { describe, it, expect } from 'vitest';
import { clampMenuPosition, computeMenuPosition, type TriggerRect } from './menu-position';

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

  it('clamps above the reserved bottom chrome (mini-player + tab bar)', () => {
    // bottomInset 128 → usable bottom = 915-128 = 787; maxY = 787-96-8 = 683
    expect(clampMenuPosition({ x: 50, y: 900 }, VW, VH, 200, 96, 8, 128).y).toBe(683);
  });
});

describe('computeMenuPosition (anchored dropdown, viewport-safe)', () => {
  const VW = 360; // a narrow phone
  const VH = 800;
  // A "Filters" button hard against the right edge — the classic overflow case.
  const rightEdgeTrigger: TriggerRect = { top: 60, bottom: 90, left: 320, right: 360 };

  it('right-aligns under the trigger when it fits', () => {
    const wideVw = 1200;
    const trigger: TriggerRect = { top: 60, bottom: 90, left: 800, right: 900 };
    const pos = computeMenuPosition(trigger, 240, 200, wideVw, VH, 'end');
    expect(pos.x).toBe(900 - 240); // right edge aligned to trigger.right
    expect(pos.y).toBe(94); // bottom + gap(4)
  });

  it('clamps a right-aligned panel that would overflow the right edge', () => {
    // end-align would put x = 350 - 240 = 110; that fits, but a wider panel on a
    // narrow screen must never push past the right margin.
    const pos = computeMenuPosition(rightEdgeTrigger, 300, 200, VW, VH, 'end');
    // max x = vw - panelW - margin = 360 - 300 - 8 = 52
    expect(pos.x).toBe(52);
    expect(pos.x + 300).toBeLessThanOrEqual(VW); // fully on-screen
  });

  it('never lets a start-aligned panel overflow the right edge either', () => {
    const trigger: TriggerRect = { top: 60, bottom: 90, left: 320, right: 350 };
    const pos = computeMenuPosition(trigger, 240, 200, VW, VH, 'start');
    expect(pos.x).toBe(360 - 240 - 8); // clamped, not left:320
    expect(pos.x).toBeGreaterThanOrEqual(8);
  });

  it('flips above the trigger when there is no room below', () => {
    const lowTrigger: TriggerRect = { top: 720, bottom: 760, left: 100, right: 200 };
    const pos = computeMenuPosition(lowTrigger, 240, 200, VW, VH, 'end');
    // above = top - gap - panelH = 720 - 4 - 200 = 516 (fits, opens upward)
    expect(pos.y).toBe(516);
  });

  it('flips above once the bottom chrome eats the room a downward panel needed', () => {
    // A trigger that WOULD fit below in a bare viewport: below = 604, room = 196,
    // panelH = 180 → opens downward at 604.
    const trigger: TriggerRect = { top: 560, bottom: 600, left: 100, right: 200 };
    expect(computeMenuPosition(trigger, 240, 180, VW, VH, 'end').y).toBe(604);
    // With a 128px mini-player + tab bar reserved, room below is only 68 → flips
    // up so the panel clears the player instead of hiding under it.
    const flipped = computeMenuPosition(trigger, 240, 180, VW, VH, 'end', undefined, undefined, 128);
    expect(flipped.y).toBe(560 - 4 - 180); // above = 376
  });
});
