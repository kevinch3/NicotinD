import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  createVerticalSwipe,
  flickVelocity,
  scrollableAncestorTop,
  shouldCommit,
  FLICK_PX_PER_MS,
  SWIPE_SLOP_PX,
  type SwipeEnd,
  type SwipeResolveContext,
  type VerticalSwipe,
} from './vertical-swipe';

// jsdom lacks PointerEvent; MouseEvent stands in (same trick as pointer-drag.spec).
function pointer(type: string, clientY: number, clientX = 0, timeStamp?: number): PointerEvent {
  const e = new MouseEvent(type, { clientY, clientX, button: 0 }) as unknown as PointerEvent;
  if (timeStamp !== undefined) Object.defineProperty(e, 'timeStamp', { value: timeStamp });
  return e;
}

// jsdom lacks TouchEvent too; a plain Event with a fabricated `touches` list
// is enough for the blocker, which only reads touches[0].clientX/clientY.
function touchMove(clientY: number, clientX = 0, cancelable = true): Event {
  const e = new Event('touchmove', { cancelable });
  Object.defineProperty(e, 'touches', { value: [{ clientY, clientX }] });
  return e;
}

@Component({ standalone: true, template: '' })
class HostComponent {
  resolveCalls: SwipeResolveContext[] = [];
  intent: 'own' | 'release' = 'own';
  moves: number[] = [];
  ends: SwipeEnd[] = [];
  releases = 0;
  readonly swipe: VerticalSwipe = createVerticalSwipe({
    resolve: (ctx) => {
      this.resolveCalls.push(ctx);
      return this.intent;
    },
    onMove: (dy) => this.moves.push(dy),
    onEnd: (end) => this.ends.push(end),
    onRelease: () => this.releases++,
  });
}

describe('flickVelocity', () => {
  it('is 0 with fewer than two samples', () => {
    expect(flickVelocity([])).toBe(0);
    expect(flickVelocity([{ t: 0, y: 10 }])).toBe(0);
  });

  it('measures px/ms over the trailing window only', () => {
    // A slow start (100px over 1s) followed by a fast finish (50px in 50ms):
    // the window must ignore the slow start.
    const samples = [
      { t: 0, y: 0 },
      { t: 1000, y: 100 },
      { t: 1030, y: 130 },
      { t: 1050, y: 150 },
    ];
    expect(flickVelocity(samples, 100)).toBeCloseTo(1, 5);
  });

  it('is signed: upward travel is negative', () => {
    expect(
      flickVelocity([
        { t: 0, y: 100 },
        { t: 20, y: 60 },
      ]),
    ).toBe(-2);
  });

  it('is 0 when the window collapses to a single instant', () => {
    expect(
      flickVelocity([
        { t: 5, y: 0 },
        { t: 5, y: 40 },
      ]),
    ).toBe(0);
  });
});

describe('shouldCommit', () => {
  const opts = { thresholdPx: 120 };

  it('commits past the distance threshold regardless of speed', () => {
    expect(shouldCommit(121, 0, opts)).toBe(true);
    expect(shouldCommit(119, 0, opts)).toBe(false);
  });

  it('commits a short but fast flick in the commit direction', () => {
    expect(shouldCommit(30, FLICK_PX_PER_MS, opts)).toBe(true);
    expect(shouldCommit(30, FLICK_PX_PER_MS - 0.01, opts)).toBe(false);
  });

  it('never commits a flick against the direction of travel or with no travel', () => {
    expect(shouldCommit(30, -5, opts)).toBe(false);
    expect(shouldCommit(0, 5, opts)).toBe(false);
  });
});

describe('scrollableAncestorTop', () => {
  it('returns the scrollTop of the nearest overflow-y auto/scroll ancestor inside the boundary', () => {
    const boundary = document.createElement('div');
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    const leaf = document.createElement('span');
    boundary.appendChild(scroller);
    scroller.appendChild(leaf);
    document.body.appendChild(boundary);
    Object.defineProperty(scroller, 'scrollTop', { value: 42, configurable: true });

    expect(scrollableAncestorTop(leaf, boundary)).toBe(42);
    boundary.remove();
  });

  it('returns 0 when no scroller sits between the target and the boundary', () => {
    const boundary = document.createElement('div');
    const leaf = document.createElement('span');
    boundary.appendChild(leaf);
    document.body.appendChild(boundary);
    // A scroller ABOVE the boundary must not count.
    const outer = document.createElement('div');
    outer.style.overflowY = 'scroll';
    Object.defineProperty(outer, 'scrollTop', { value: 99, configurable: true });
    outer.appendChild(boundary);
    document.body.appendChild(outer);

    expect(scrollableAncestorTop(leaf, boundary)).toBe(0);
    expect(scrollableAncestorTop(null, boundary)).toBe(0);
    outer.remove();
  });
});

describe('createVerticalSwipe', () => {
  function setup() {
    const fixture = TestBed.createComponent(HostComponent);
    return { host: fixture.componentInstance, fixture };
  }

  it('does not resolve or move inside the slop zone', () => {
    const { host } = setup();
    host.swipe.start(pointer('pointerdown', 100));
    document.dispatchEvent(pointer('pointermove', 100 + SWIPE_SLOP_PX - 1));
    expect(host.resolveCalls).toHaveLength(0);
    expect(host.moves).toHaveLength(0);
    expect(host.swipe.dragging()).toBe(true);
  });

  it('resolves once past slop with the signed deltas and the pointerdown target, then streams dy', () => {
    const { host } = setup();
    const target = document.createElement('div');
    const down = pointer('pointerdown', 100, 50);
    Object.defineProperty(down, 'target', { value: target });
    host.swipe.start(down);
    document.dispatchEvent(pointer('pointermove', 60, 55));
    document.dispatchEvent(pointer('pointermove', 30, 55));

    expect(host.resolveCalls).toHaveLength(1);
    expect(host.resolveCalls[0]).toMatchObject({ target, dx: 5, dy: -40 });
    expect(host.moves).toEqual([-40, -70]);
  });

  it('releases a horizontal-dominant move without consulting resolve', () => {
    const { host } = setup();
    host.swipe.start(pointer('pointerdown', 100, 100));
    document.dispatchEvent(pointer('pointermove', 105, 160));
    expect(host.resolveCalls).toHaveLength(0);
    expect(host.releases).toBe(1);
    expect(host.swipe.dragging()).toBe(false);
    // Detached: later moves are ignored.
    document.dispatchEvent(pointer('pointermove', 300, 160));
    expect(host.moves).toHaveLength(0);
  });

  it('releases when resolve says so and stops tracking', () => {
    const { host } = setup();
    host.intent = 'release';
    host.swipe.start(pointer('pointerdown', 100));
    document.dispatchEvent(pointer('pointermove', 150));
    expect(host.releases).toBe(1);
    expect(host.moves).toHaveLength(0);
    document.dispatchEvent(pointer('pointerup', 200));
    expect(host.ends).toHaveLength(0);
  });

  it('ends an owned gesture with the final dy and the trailing velocity', () => {
    const { host } = setup();
    host.swipe.start(pointer('pointerdown', 100, 0, 0));
    document.dispatchEvent(pointer('pointermove', 150, 0, 50));
    document.dispatchEvent(pointer('pointermove', 200, 0, 100));
    document.dispatchEvent(pointer('pointerup', 200, 0, 100));

    expect(host.ends).toHaveLength(1);
    expect(host.ends[0]).toMatchObject({ dy: 100, owned: true });
    expect(host.ends[0].velocity).toBeCloseTo(1, 5);
    expect(host.swipe.dragging()).toBe(false);
  });

  it('ends an unresolved gesture (a tap) with owned=false', () => {
    const { host } = setup();
    host.swipe.start(pointer('pointerdown', 100));
    document.dispatchEvent(pointer('pointerup', 103));
    expect(host.ends).toEqual([{ dy: 3, velocity: 0, owned: false }]);
    expect(host.releases).toBe(0);
  });

  // On touch the browser may never deliver pointerup once it reclaims the pan
  // (same lesson as pull-to-refresh / the old mini-bar swipe).
  it('routes pointercancel through onEnd so an interrupted gesture still settles', () => {
    const { host } = setup();
    host.swipe.start(pointer('pointerdown', 100));
    document.dispatchEvent(pointer('pointermove', 200));
    document.dispatchEvent(pointer('pointercancel', 200));
    expect(host.ends).toHaveLength(1);
    expect(host.ends[0].owned).toBe(true);
  });

  it('ignores non-primary buttons', () => {
    const { host } = setup();
    const e = new MouseEvent('pointerdown', { clientY: 100, button: 2 }) as unknown as PointerEvent;
    host.swipe.start(e);
    expect(host.swipe.dragging()).toBe(false);
  });

  describe('touchmove blocker', () => {
    it('prevents a vertical first touchmove immediately after pointerdown when resolve owns it', () => {
      const { host } = setup();
      host.swipe.start(pointer('pointerdown', 100));
      const e = touchMove(96); // 4px up — under slop, direction already decisive
      document.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(true);
      // The blocker asked the same resolve the move handler uses.
      expect(host.resolveCalls).toHaveLength(1);
      expect(host.resolveCalls[0]).toMatchObject({ dy: -4 });
    });

    it('lets the first touchmove through when resolve releases it, and never blocks afterwards', () => {
      const { host } = setup();
      host.intent = 'release';
      host.swipe.start(pointer('pointerdown', 100));
      const first = touchMove(110);
      document.dispatchEvent(first);
      expect(first.defaultPrevented).toBe(false);
      host.intent = 'own';
      const later = touchMove(200);
      document.dispatchEvent(later);
      expect(later.defaultPrevented).toBe(false);
      expect(host.releases).toBe(1);
    });

    it('lets a horizontal-dominant first touchmove through', () => {
      const { host } = setup();
      host.swipe.start(pointer('pointerdown', 100, 100));
      const e = touchMove(103, 140);
      document.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
      expect(host.resolveCalls).toHaveLength(0);
    });

    it('keeps preventing once owned and stops after the gesture ends', () => {
      const { host } = setup();
      host.swipe.start(pointer('pointerdown', 100));
      document.dispatchEvent(pointer('pointermove', 150));
      const live = touchMove(160, 80); // even a sideways move is ours now
      document.dispatchEvent(live);
      expect(live.defaultPrevented).toBe(true);
      document.dispatchEvent(pointer('pointerup', 160));
      const after = touchMove(200);
      document.dispatchEvent(after);
      expect(after.defaultPrevented).toBe(false);
    });

    it('never calls preventDefault on a non-cancelable touchmove', () => {
      const { host } = setup();
      host.swipe.start(pointer('pointerdown', 100));
      const e = touchMove(150, 0, false);
      expect(() => document.dispatchEvent(e)).not.toThrow();
      expect(e.defaultPrevented).toBe(false);
    });

    it('detaches the blocker when the host is destroyed mid-gesture', () => {
      const { host, fixture } = setup();
      host.swipe.start(pointer('pointerdown', 100));
      fixture.destroy();
      const e = touchMove(150);
      document.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
    });
  });
});
