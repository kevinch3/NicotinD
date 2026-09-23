/**
 * createVerticalSwipe — a vertical pan gesture that can be *owned* (we move a
 * sheet/panel) or *released* (the browser scrolls), composed on
 * createPointerDrag. It carries the touch-ownership rule pull-to-refresh
 * learned the hard way (#731): a non-passive `touchmove` blocker is armed at
 * pointerdown and the FIRST cancelable touchmove decides — after ~10px an
 * unprevented vertical pan is the browser's, `pointercancel` follows and the
 * rest of the moves never arrive. `resolve` is asked exactly once, by whichever
 * of the blocker or the pointermove stream crosses first, so the two can never
 * disagree about who owns the finger.
 *
 * Call sites keep their own math (offsets, thresholds, persistence); this
 * primitive owns intent, the blocker lifecycle and the flick measurement.
 * See docs/web-ui.md "Player expand/collapse gesture".
 *
 * Must be called within an injection context.
 */
import { DestroyRef, inject, type Signal } from '@angular/core';
import { createPointerDrag } from './pointer-drag';

/** Dead zone before intent is classified (a tap never crosses it). */
export const SWIPE_SLOP_PX = 10;
/** Trailing velocity that commits a swipe short of its distance threshold. */
export const FLICK_PX_PER_MS = 0.5;
/** Window the flick velocity is measured over. */
export const FLICK_WINDOW_MS = 100;

export type SwipeIntent = 'own' | 'release';

export interface SwipeResolveContext {
  /** The pointerdown target — where the finger landed, not where it is now. */
  target: EventTarget | null;
  dx: number;
  /** Signed: positive is downward. */
  dy: number;
}

export interface SwipeEnd {
  /** Signed finger travel since pointerdown. */
  dy: number;
  /** Trailing px/ms, signed like `dy`. 0 for a gesture that never moved. */
  velocity: number;
  /** False for a pointerup inside the slop zone (a tap). */
  owned: boolean;
}

export interface VerticalSwipeOptions {
  /** Called once at the first vertical-dominant move past slop. */
  resolve: (ctx: SwipeResolveContext) => SwipeIntent;
  /** Streams the signed dy while the gesture is owned. */
  onMove?: (dy: number, e: PointerEvent) => void;
  /** pointerup OR pointercancel of an owned gesture, plus a tap (owned=false). */
  onEnd?: (end: SwipeEnd) => void;
  /** The finger went to the browser (horizontal, or `resolve` said release). */
  onRelease?: () => void;
}

export interface VerticalSwipe {
  /** True from `start()` until the gesture ends or is released. */
  readonly dragging: Signal<boolean>;
  /** Bind to `(pointerdown)`. No-op for non-primary buttons. */
  start: (e: PointerEvent) => void;
}

export interface VelocitySample {
  t: number;
  y: number;
}

/** Signed px/ms over the trailing `windowMs` of samples; 0 when unmeasurable. */
export function flickVelocity(samples: VelocitySample[], windowMs = FLICK_WINDOW_MS): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  let first = last;
  for (let i = samples.length - 2; i >= 0; i--) {
    if (last.t - samples[i].t > windowMs) break;
    first = samples[i];
  }
  const dt = last.t - first.t;
  return dt > 0 ? (last.y - first.y) / dt : 0;
}

/**
 * Distance past the threshold, or a flick in the commit direction. Both
 * arguments are measured in the commit direction (positive = towards commit).
 */
export function shouldCommit(
  distancePx: number,
  velocityPxPerMs: number,
  opts: { thresholdPx: number; flickPxPerMs?: number },
): boolean {
  if (distancePx <= 0) return false;
  if (distancePx >= opts.thresholdPx) return true;
  return velocityPxPerMs >= (opts.flickPxPerMs ?? FLICK_PX_PER_MS);
}

/**
 * scrollTop of the nearest overflow-y auto/scroll ancestor of `target`, walking
 * no further than `boundary`; 0 when there is none. Lets a sheet gesture yield
 * to a nested list that still has room to scroll up.
 */
export function scrollableAncestorTop(target: EventTarget | null, boundary: Element): number {
  let el = target instanceof Element ? target : null;
  while (el) {
    const overflowY = getComputedStyle(el).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return el.scrollTop;
    if (el === boundary) return 0;
    el = el.parentElement;
  }
  return 0;
}

export function createVerticalSwipe(options: VerticalSwipeOptions): VerticalSwipe {
  let intent: 'undecided' | 'own' | 'release' = 'undecided';
  let origin: { target: EventTarget | null; x: number; y: number } | null = null;
  let samples: VelocitySample[] = [];

  const decide = (dx: number, dy: number): SwipeIntent => {
    if (intent === 'undecided') {
      intent = options.resolve({ target: origin?.target ?? null, dx, dy });
    }
    return intent;
  };

  const blockTouchMove = (e: TouchEvent): void => {
    if (intent === 'release' || !e.cancelable) return;
    if (intent === 'own') {
      e.preventDefault();
      return;
    }
    const t = e.touches[0];
    if (!t || !origin) return;
    const dx = t.clientX - origin.x;
    const dy = t.clientY - origin.y;
    // Direction is decisive from the first pixel; dominance mirrors onMove.
    if (dy === 0 || Math.abs(dy) < Math.abs(dx)) return;
    if (decide(dx, dy) === 'own') e.preventDefault();
    else release();
  };
  const attachBlocker = (): void =>
    document.addEventListener('touchmove', blockTouchMove, { passive: false });
  const removeBlocker = (): void => document.removeEventListener('touchmove', blockTouchMove);

  const drag = createPointerDrag({
    onStart: (e) => {
      intent = 'undecided';
      origin = { target: e.target, x: e.clientX, y: e.clientY };
      samples = [{ t: e.timeStamp, y: e.clientY }];
      attachBlocker();
    },
    onMove: (e, start) => {
      if (intent === 'release' || !origin) return;
      const dy = e.clientY - start.clientY;
      const dx = e.clientX - start.clientX;
      if (intent === 'undecided') {
        if (Math.abs(dy) < SWIPE_SLOP_PX && Math.abs(dx) < SWIPE_SLOP_PX) return;
        if (Math.abs(dy) <= Math.abs(dx) || decide(dx, dy) === 'release') {
          release();
          return;
        }
      }
      samples.push({ t: e.timeStamp, y: e.clientY });
      options.onMove?.(dy, e);
    },
    onEnd: (e, start) => finish(e, start),
    onCancel: (e, start) => finish(e, start),
  });

  // Hand the finger back: detach everything now rather than on pointerup,
  // which a reclaimed touch pan may never deliver.
  const release = (): void => {
    intent = 'release';
    removeBlocker();
    drag.cancel();
    options.onRelease?.();
  };

  const finish = (e: PointerEvent, start: PointerEvent): void => {
    removeBlocker();
    if (intent === 'release') return;
    const owned = intent === 'own';
    if (owned) samples.push({ t: e.timeStamp, y: e.clientY });
    const end: SwipeEnd = {
      dy: e.clientY - start.clientY,
      velocity: owned ? flickVelocity(samples) : 0,
      owned,
    };
    intent = 'undecided';
    origin = null;
    samples = [];
    options.onEnd?.(end);
  };

  inject(DestroyRef).onDestroy(removeBlocker);

  return { dragging: drag.dragging, start: drag.start };
}
