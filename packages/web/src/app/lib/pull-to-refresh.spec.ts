import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  createPullToRefresh,
  dampPull,
  PullToRefresh,
  PULL_MAX_PX,
  PULL_SLOP_PX,
  PULL_THRESHOLD_PX,
} from './pull-to-refresh';

// jsdom lacks PointerEvent; MouseEvent stands in (same trick as pointer-drag.spec).
// pointerType is undefined on the fake — the factory only rejects an explicit
// 'mouse', so undefined behaves like touch, which is what the tests need.
function pointer(type: string, clientY: number, clientX = 0): PointerEvent {
  return new MouseEvent(type, { clientY, clientX, button: 0 }) as unknown as PointerEvent;
}

function mousePointer(type: string, clientY: number): PointerEvent {
  const e = pointer(type, clientY);
  Object.defineProperty(e, 'pointerType', { value: 'mouse' });
  return e;
}

@Component({ standalone: true, template: '' })
class HostComponent {
  refreshes = 0;
  resolveRefresh: (() => void) | null = null;
  canStart = true;
  readonly pull: PullToRefresh = createPullToRefresh({
    canStart: () => this.canStart,
    onRefresh: () => {
      this.refreshes++;
      return new Promise<void>((resolve) => (this.resolveRefresh = resolve));
    },
  });
}

@Component({ standalone: true, template: '' })
class ThrowingHostComponent {
  readonly pull: PullToRefresh = createPullToRefresh({
    onRefresh: () => {
      throw new Error('synchronous onRefresh failure');
    },
  });
}

describe('dampPull', () => {
  it('is 0 at or below 0 and monotonically approaches PULL_MAX_PX', () => {
    expect(dampPull(-5)).toBe(0);
    expect(dampPull(0)).toBe(0);
    expect(dampPull(50)).toBeGreaterThan(0);
    expect(dampPull(100)).toBeGreaterThan(dampPull(50));
    expect(dampPull(10_000)).toBeLessThanOrEqual(PULL_MAX_PX);
  });
});

describe('createPullToRefresh', () => {
  function setup() {
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true, writable: true });
    const fixture = TestBed.createComponent(HostComponent);
    return { host: fixture.componentInstance };
  }

  /** Drives a pull from y=100 down past slop to `toY`. */
  function pullTo(host: HostComponent, toY: number) {
    host.pull.onPointerDown(pointer('pointerdown', 100));
    document.dispatchEvent(pointer('pointermove', toY));
  }

  it('ignores pointerdown when canStart is false', () => {
    const { host } = setup();
    host.canStart = false;
    pullTo(host, 300);
    expect(host.pull.phase()).toBe('idle');
  });

  it('ignores pointerdown when not at scroll top', () => {
    const { host } = setup();
    Object.defineProperty(window, 'scrollY', { value: 50, configurable: true, writable: true });
    pullTo(host, 300);
    expect(host.pull.phase()).toBe('idle');
  });

  it('ignores mouse pointers', () => {
    const { host } = setup();
    host.pull.onPointerDown(mousePointer('pointerdown', 100));
    document.dispatchEvent(pointer('pointermove', 300));
    expect(host.pull.phase()).toBe('idle');
  });

  it('aborts silently when the first move past slop is upward', () => {
    const { host } = setup();
    host.pull.onPointerDown(pointer('pointerdown', 100));
    document.dispatchEvent(pointer('pointermove', 100 - PULL_SLOP_PX - 5));
    expect(host.pull.phase()).toBe('idle');
    // later downward moves in the same drag must not resurrect it
    document.dispatchEvent(pointer('pointermove', 300));
    expect(host.pull.phase()).toBe('idle');
  });

  it('aborts silently when the first move past slop is horizontal', () => {
    const { host } = setup();
    host.pull.onPointerDown(pointer('pointerdown', 100, 100));
    document.dispatchEvent(pointer('pointermove', 105, /* clientX */ 140));
    expect(host.pull.phase()).toBe('idle');
  });

  it('enters pulling with damped pullPx on a downward pull past slop', () => {
    const { host } = setup();
    pullTo(host, 100 + PULL_SLOP_PX + 40);
    expect(host.pull.phase()).toBe('pulling');
    expect(host.pull.pullPx()).toBeCloseTo(dampPull(40), 5);
  });

  it('arms at the threshold and disarms if the finger pushes back up', () => {
    const { host } = setup();
    pullTo(host, 400); // damp(290) ≈ 109 > 70
    expect(host.pull.phase()).toBe('armed');
    document.dispatchEvent(pointer('pointermove', 100 + PULL_SLOP_PX + 30)); // damp(30) < 70
    expect(host.pull.phase()).toBe('pulling');
  });

  it('release before arming springs back to idle without refreshing', () => {
    const { host } = setup();
    pullTo(host, 140);
    document.dispatchEvent(pointer('pointerup', 140));
    expect(host.pull.phase()).toBe('idle');
    expect(host.pull.pullPx()).toBe(0);
    expect(host.refreshes).toBe(0);
  });

  it('release while armed refreshes, holds refreshing until the promise settles', async () => {
    const { host } = setup();
    pullTo(host, 400);
    document.dispatchEvent(pointer('pointerup', 400));
    expect(host.pull.phase()).toBe('refreshing');
    expect(host.refreshes).toBe(1);
    host.resolveRefresh!();
    await new Promise((r) => setTimeout(r, 0)); // flush the then/catch/finally chain
    expect(host.pull.phase()).toBe('idle');
    expect(host.pull.pullPx()).toBe(0);
  });

  it('pointercancel before arming aborts; while armed it commits the refresh', () => {
    const { host } = setup();
    pullTo(host, 140);
    document.dispatchEvent(pointer('pointercancel', 140));
    expect(host.pull.phase()).toBe('idle');
    expect(host.refreshes).toBe(0);

    pullTo(host, 400);
    document.dispatchEvent(pointer('pointercancel', 400));
    expect(host.pull.phase()).toBe('refreshing');
    expect(host.refreshes).toBe(1);
  });

  it('blocks touchmove (preventDefault) only while a pull is live', () => {
    const { host } = setup();
    const dispatchTouchMove = () => {
      const e = new Event('touchmove', { cancelable: true });
      document.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(dispatchTouchMove()).toBe(false);
    pullTo(host, 200);
    expect(dispatchTouchMove()).toBe(true);
    document.dispatchEvent(pointer('pointerup', 200));
    expect(dispatchTouchMove()).toBe(false);
  });

  it('ignores a new pointerdown while refreshing', () => {
    const { host } = setup();
    pullTo(host, 400);
    document.dispatchEvent(pointer('pointerup', 400));
    expect(host.pull.phase()).toBe('refreshing');
    pullTo(host, 400);
    expect(host.refreshes).toBe(1);
  });

  it('a synchronously throwing onRefresh still resets to idle and does not wedge the gesture', async () => {
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true, writable: true });
    const fixture = TestBed.createComponent(ThrowingHostComponent);
    const host = fixture.componentInstance;

    host.pull.onPointerDown(pointer('pointerdown', 100));
    document.dispatchEvent(pointer('pointermove', 400));
    expect(() => document.dispatchEvent(pointer('pointerup', 400))).not.toThrow();
    expect(host.pull.phase()).toBe('refreshing'); // still settling until the microtask flushes

    await new Promise((r) => setTimeout(r, 0)); // flush the catch/finally chain

    expect(host.pull.phase()).toBe('idle');
    expect(host.pull.pullPx()).toBe(0);

    // the touchmove blocker must not be left attached either.
    const e = new Event('touchmove', { cancelable: true });
    document.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);

    // and the gesture must not be permanently wedged: a fresh pull works.
    host.pull.onPointerDown(pointer('pointerdown', 100));
    document.dispatchEvent(pointer('pointermove', 400));
    expect(host.pull.phase()).toBe('armed');
  });
});
