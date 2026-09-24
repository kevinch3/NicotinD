import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  createRowGesture,
  LONG_PRESS_MS,
  reorderTargetIndex,
  type RowGesture,
  type RowReorderEnd,
  type RowSwipeEnd,
} from './row-gesture';
import { SWIPE_SLOP_PX } from './vertical-swipe';

// jsdom lacks PointerEvent; MouseEvent stands in (same trick as vertical-swipe.spec).
function pointer(
  type: string,
  clientX: number,
  clientY: number,
  opts: { pointerType?: string; timeStamp?: number } = {},
): PointerEvent {
  const e = new MouseEvent(type, { clientX, clientY, button: 0 }) as unknown as PointerEvent;
  Object.defineProperty(e, 'pointerType', { value: opts.pointerType ?? 'touch' });
  if (opts.timeStamp !== undefined)
    Object.defineProperty(e, 'timeStamp', { value: opts.timeStamp });
  return e;
}

function touchMove(cancelable = true): Event {
  const e = new Event('touchmove', { cancelable });
  Object.defineProperty(e, 'touches', { value: [{ clientX: 0, clientY: 0 }] });
  return e;
}

@Component({ standalone: true, template: '' })
class HostComponent {
  swipeMoves: number[] = [];
  swipeEnds: RowSwipeEnd[] = [];
  reorderStarts = 0;
  reorderMoves: number[] = [];
  reorderEnds: RowReorderEnd[] = [];
  readonly gesture: RowGesture = createRowGesture({
    onSwipeMove: (dx) => this.swipeMoves.push(dx),
    onSwipeEnd: (end) => this.swipeEnds.push(end),
    onReorderStart: () => this.reorderStarts++,
    onReorderMove: (dy) => this.reorderMoves.push(dy),
    onReorderEnd: (end) => this.reorderEnds.push(end),
  });
}

describe('createRowGesture', () => {
  let host: HostComponent;

  beforeEach(() => {
    vi.useFakeTimers();
    host = TestBed.createComponent(HostComponent).componentInstance;
  });
  afterEach(() => {
    document.dispatchEvent(pointer('pointerup', 0, 0));
    vi.useRealTimers();
  });

  describe('ownership', () => {
    it('does not block touchmove before the long-press — the list can still scroll', () => {
      host.gesture.start(pointer('pointerdown', 100, 100));
      const move = touchMove();
      document.dispatchEvent(move);
      expect(move.defaultPrevented).toBe(false);
    });

    it('arms the touchmove blocker at the long-press, so a vertical drag is ours', () => {
      host.gesture.start(pointer('pointerdown', 100, 100));
      vi.advanceTimersByTime(LONG_PRESS_MS);
      expect(host.gesture.mode()).toBe('reorder');
      expect(host.reorderStarts).toBe(1);
      const move = touchMove();
      document.dispatchEvent(move);
      expect(move.defaultPrevented).toBe(true);
      document.dispatchEvent(pointer('pointermove', 100, 160));
      expect(host.reorderMoves).toEqual([60]);
    });

    it('releases on a plain vertical pan: no long-press, no blocker, no callbacks', () => {
      host.gesture.start(pointer('pointerdown', 100, 100));
      document.dispatchEvent(pointer('pointermove', 102, 100 + SWIPE_SLOP_PX + 5));
      expect(host.gesture.mode()).toBe('idle');
      vi.advanceTimersByTime(LONG_PRESS_MS * 2);
      expect(host.reorderStarts).toBe(0);
      const move = touchMove();
      document.dispatchEvent(move);
      expect(move.defaultPrevented).toBe(false);
      document.dispatchEvent(pointer('pointerup', 102, 200));
      expect(host.swipeEnds).toEqual([]);
      expect(host.reorderEnds).toEqual([]);
    });

    it('stays pending inside the slop, so a still finger reaches the long-press', () => {
      host.gesture.start(pointer('pointerdown', 100, 100));
      document.dispatchEvent(pointer('pointermove', 103, 104));
      expect(host.gesture.mode()).toBe('pending');
      vi.advanceTimersByTime(LONG_PRESS_MS);
      expect(host.gesture.mode()).toBe('reorder');
    });

    it('never long-presses a mouse into a reorder (it has HTML5 drag)', () => {
      host.gesture.start(pointer('pointerdown', 100, 100, { pointerType: 'mouse' }));
      vi.advanceTimersByTime(LONG_PRESS_MS * 2);
      expect(host.gesture.mode()).toBe('pending');
      expect(host.reorderStarts).toBe(0);
    });

    it('disarms the blocker when the reorder ends', () => {
      host.gesture.start(pointer('pointerdown', 100, 100));
      vi.advanceTimersByTime(LONG_PRESS_MS);
      document.dispatchEvent(pointer('pointerup', 100, 150));
      expect(host.reorderEnds).toEqual([{ dy: 50, cancelled: false }]);
      const move = touchMove();
      document.dispatchEvent(move);
      expect(move.defaultPrevented).toBe(false);
    });
  });

  describe('swipe', () => {
    it('becomes a swipe on a horizontal move past slop and cancels the long-press', () => {
      host.gesture.start(pointer('pointerdown', 200, 100));
      document.dispatchEvent(pointer('pointermove', 180, 102));
      expect(host.gesture.mode()).toBe('swipe');
      vi.advanceTimersByTime(LONG_PRESS_MS);
      expect(host.reorderStarts).toBe(0);
      expect(host.swipeMoves).toEqual([-20]);
    });

    it('reports travel and trailing velocity on release', () => {
      host.gesture.start(pointer('pointerdown', 200, 100, { timeStamp: 0 }));
      document.dispatchEvent(pointer('pointermove', 180, 100, { timeStamp: 1000 }));
      document.dispatchEvent(pointer('pointermove', 140, 100, { timeStamp: 1020 }));
      document.dispatchEvent(pointer('pointerup', 140, 100, { timeStamp: 1020 }));
      expect(host.swipeEnds).toHaveLength(1);
      expect(host.swipeEnds[0]!.dx).toBe(-60);
      expect(host.swipeEnds[0]!.velocity).toBeCloseTo(-2, 5);
      expect(host.swipeEnds[0]!.cancelled).toBe(false);
    });

    it('a mouse can swipe too', () => {
      host.gesture.start(pointer('pointerdown', 200, 100, { pointerType: 'mouse' }));
      document.dispatchEvent(pointer('pointermove', 100, 100, { pointerType: 'mouse' }));
      document.dispatchEvent(pointer('pointerup', 100, 100, { pointerType: 'mouse' }));
      expect(host.swipeEnds[0]!.dx).toBe(-100);
    });

    it('marks a pointercancel as cancelled so the caller never commits it', () => {
      host.gesture.start(pointer('pointerdown', 200, 100));
      document.dispatchEvent(pointer('pointermove', 60, 100));
      document.dispatchEvent(pointer('pointercancel', 60, 100));
      expect(host.swipeEnds[0]!.cancelled).toBe(true);
      expect(host.gesture.mode()).toBe('idle');
    });

    it('a tap reports nothing', () => {
      host.gesture.start(pointer('pointerdown', 200, 100));
      document.dispatchEvent(pointer('pointerup', 200, 100));
      expect(host.swipeEnds).toEqual([]);
      expect(host.reorderEnds).toEqual([]);
      expect(host.gesture.mode()).toBe('idle');
    });
  });
});

describe('reorderTargetIndex', () => {
  // Rows 50px tall: midpoints 25, 75, 125, 175.
  const mids = [25, 75, 125, 175];

  it('stays put inside half a row', () => {
    expect(reorderTargetIndex(mids, 1, 20)).toBe(1);
    expect(reorderTargetIndex(mids, 1, -20)).toBe(1);
  });

  it('moves down past a sibling midpoint', () => {
    expect(reorderTargetIndex(mids, 0, 60)).toBe(1);
    expect(reorderTargetIndex(mids, 0, 160)).toBe(3);
  });

  it('moves up past a sibling midpoint and clamps at the ends', () => {
    expect(reorderTargetIndex(mids, 3, -60)).toBe(2);
    expect(reorderTargetIndex(mids, 3, -500)).toBe(0);
    expect(reorderTargetIndex(mids, 0, 500)).toBe(3);
  });
});
