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
 * `createHorizontalSwipe` is the same machine on the other axis. Both may be
 * started from one pointerdown: dominance is decided by the same rule on the
 * same event, and the first to own the pointer claims it, so the other
 * releases instead of ever firing alongside it.
 * See docs/web-ui.md "Player expand/collapse gesture" and "Swipe to skip".
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
export type SwipeAxis = 'x' | 'y';

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

export interface HorizontalSwipeEnd {
  /** Signed finger travel since pointerdown; positive is rightward. */
  dx: number;
  /** Trailing px/ms, signed like `dx`. 0 for a gesture that never moved. */
  velocity: number;
  /** False for a pointerup inside the slop zone (a tap). */
  owned: boolean;
}

export interface HorizontalSwipeOptions {
  /** Called once at the first horizontal-dominant move past slop. */
  resolve: (ctx: SwipeResolveContext) => SwipeIntent;
  /** Streams the signed dx while the gesture is owned. */
  onMove?: (dx: number, e: PointerEvent) => void;
  /** pointerup OR pointercancel of an owned gesture, plus a tap (owned=false). */
  onEnd?: (end: HorizontalSwipeEnd) => void;
  /** The finger went elsewhere (vertical, or `resolve` said release). */
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
  /** Position along the swipe's axis. */
  pos: number;
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
  return dt > 0 ? (last.pos - first.pos) / dt : 0;
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

/**
 * Which axis a move belongs to. `tie` settles |dx| === |dy|: the touchmove
 * blocker hands a tie to the vertical swipe and the pointermove stream to the
 * horizontal one (the rules `createVerticalSwipe` shipped with), and every
 * swipe on a pointer asks the same question of the same event.
 */
export function dominantAxis(dx: number, dy: number, tie: SwipeAxis): SwipeAxis {
  if (Math.abs(dx) === Math.abs(dy)) return tie;
  return Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
}

interface AxisSwipeOptions {
  axis: SwipeAxis;
  resolve: (ctx: SwipeResolveContext) => SwipeIntent;
  onMove?: (delta: number, e: PointerEvent) => void;
  onEnd?: (end: { delta: number; velocity: number; owned: boolean }) => void;
  onRelease?: () => void;
}

/** The swipe that owns the pointer of a given pointerdown, if any. Two swipes
 *  started from the same event compare against it before owning. */
let claim: { down: PointerEvent; owner: object } | null = null;

function createAxisSwipe(options: AxisSwipeOptions): VerticalSwipe {
  const self = {};
  const along = (dx: number, dy: number): number => (options.axis === 'y' ? dy : dx);
  const coord = (e: { clientX: number; clientY: number }): number =>
    options.axis === 'y' ? e.clientY : e.clientX;
  let intent: 'undecided' | 'own' | 'release' = 'undecided';
  let origin: { down: PointerEvent; target: EventTarget | null; x: number; y: number } | null =
    null;
  let samples: VelocitySample[] = [];

  const unclaim = (): void => {
    if (claim?.owner === self) claim = null;
  };

  const decide = (dx: number, dy: number): SwipeIntent => {
    if (intent === 'undecided' && origin) {
      const taken = claim && claim.down === origin.down && claim.owner !== self;
      intent = taken ? 'release' : options.resolve({ target: origin.target, dx, dy });
      if (intent === 'own') claim = { down: origin.down, owner: self };
    }
    return intent === 'own' ? 'own' : 'release';
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
    if (along(dx, dy) === 0 || dominantAxis(dx, dy, 'y') !== options.axis) return;
    if (decide(dx, dy) === 'own') e.preventDefault();
    else release();
  };
  const attachBlocker = (): void =>
    document.addEventListener('touchmove', blockTouchMove, { passive: false });
  const removeBlocker = (): void => document.removeEventListener('touchmove', blockTouchMove);

  const drag = createPointerDrag({
    onStart: (e) => {
      intent = 'undecided';
      origin = { down: e, target: e.target, x: e.clientX, y: e.clientY };
      samples = [{ t: e.timeStamp, pos: coord(e) }];
      attachBlocker();
    },
    onMove: (e, start) => {
      if (intent === 'release' || !origin) return;
      const dy = e.clientY - start.clientY;
      const dx = e.clientX - start.clientX;
      if (intent === 'undecided') {
        if (Math.abs(dy) < SWIPE_SLOP_PX && Math.abs(dx) < SWIPE_SLOP_PX) return;
        if (dominantAxis(dx, dy, 'x') !== options.axis || decide(dx, dy) === 'release') {
          release();
          return;
        }
      }
      samples.push({ t: e.timeStamp, pos: coord(e) });
      options.onMove?.(along(dx, dy), e);
    },
    onEnd: (e, start) => finish(e, start),
    onCancel: (e, start) => finish(e, start),
  });

  // Hand the finger back: detach everything now rather than on pointerup,
  // which a reclaimed touch pan may never deliver.
  const release = (): void => {
    intent = 'release';
    removeBlocker();
    unclaim();
    drag.cancel();
    options.onRelease?.();
  };

  const finish = (e: PointerEvent, start: PointerEvent): void => {
    removeBlocker();
    unclaim();
    if (intent === 'release') return;
    const owned = intent === 'own';
    if (owned) samples.push({ t: e.timeStamp, pos: coord(e) });
    const end = {
      delta: coord(e) - coord(start),
      velocity: owned ? flickVelocity(samples) : 0,
      owned,
    };
    intent = 'undecided';
    origin = null;
    samples = [];
    options.onEnd?.(end);
  };

  inject(DestroyRef).onDestroy(() => {
    removeBlocker();
    unclaim();
  });

  return { dragging: drag.dragging, start: drag.start };
}

export function createVerticalSwipe(options: VerticalSwipeOptions): VerticalSwipe {
  return createAxisSwipe({
    axis: 'y',
    resolve: options.resolve,
    onMove: options.onMove,
    onEnd:
      options.onEnd &&
      (({ delta, velocity, owned }) => options.onEnd?.({ dy: delta, velocity, owned })),
    onRelease: options.onRelease,
  });
}

/** The sideways sibling of `createVerticalSwipe`: same slop, blocker and flick
 *  rules, owning horizontal-dominant moves. Must be called within an injection
 *  context. */
export function createHorizontalSwipe(options: HorizontalSwipeOptions): VerticalSwipe {
  return createAxisSwipe({
    axis: 'x',
    resolve: options.resolve,
    onMove: options.onMove,
    onEnd:
      options.onEnd &&
      (({ delta, velocity, owned }) => options.onEnd?.({ dx: delta, velocity, owned })),
    onRelease: options.onRelease,
  });
}
