/**
 * createRowGesture — the two gestures a list row answers on a touch screen,
 * composed on createPointerDrag: a horizontal **swipe** (the row follows the
 * finger; the caller commits on distance or flick via `shouldCommit`) and a
 * **long-press then drag** (reorder). A plain vertical pan belongs to the
 * browser, so the list keeps scrolling.
 *
 * Ownership, the #731 lesson applied to a scroll list: the row carries
 * `touch-action: pan-y`, so a horizontal move is never a browser pan and needs
 * no blocker. A vertical move is the list's scroll *unless* the long-press has
 * already fired — so the non-passive `touchmove` blocker is armed only at the
 * long-press, and a vertical move past slop before it disarms the timer and
 * hands the finger back. A mouse never long-presses into a reorder (it has
 * HTML5 drag on the handle), but it can swipe. See docs/web-ui.md
 * "Queue row gestures".
 *
 * Must be called within an injection context.
 */
import { DestroyRef, inject, signal, type Signal } from '@angular/core';
import { createPointerDrag } from './pointer-drag';
import { flickVelocity, SWIPE_SLOP_PX, type VelocitySample } from './vertical-swipe';

/** Hold time before a stationary touch becomes a reorder drag. */
export const LONG_PRESS_MS = 300;

export type RowGestureMode = 'idle' | 'pending' | 'swipe' | 'reorder';

export interface RowSwipeEnd {
  /** Signed horizontal travel; negative is leftward. */
  dx: number;
  /** Trailing px/ms, signed like `dx`. */
  velocity: number;
  /** pointercancel — the caller should settle, never commit. */
  cancelled: boolean;
}

export interface RowReorderEnd {
  /** Signed vertical travel since pointerdown. */
  dy: number;
  cancelled: boolean;
}

export interface RowGestureOptions {
  longPressMs?: number;
  /** May this pointer long-press into a reorder? Default: anything but a mouse. */
  canReorder?: (e: PointerEvent) => boolean;
  onSwipeMove?: (dx: number) => void;
  onSwipeEnd?: (end: RowSwipeEnd) => void;
  onReorderStart?: () => void;
  onReorderMove?: (dy: number, e: PointerEvent) => void;
  onReorderEnd?: (end: RowReorderEnd) => void;
}

export interface RowGesture {
  readonly mode: Signal<RowGestureMode>;
  /** Bind to the row's `(pointerdown)`. No-op for non-primary buttons. */
  start: (e: PointerEvent) => void;
}

export function createRowGesture(options: RowGestureOptions): RowGesture {
  const longPressMs = options.longPressMs ?? LONG_PRESS_MS;
  const canReorder = options.canReorder ?? ((e: PointerEvent) => e.pointerType !== 'mouse');
  const mode = signal<RowGestureMode>('idle');
  let timer: ReturnType<typeof setTimeout> | null = null;
  let samples: VelocitySample[] = [];

  const blockTouchMove = (e: TouchEvent): void => {
    if (mode() === 'reorder' && e.cancelable) e.preventDefault();
  };
  const removeBlocker = (): void => document.removeEventListener('touchmove', blockTouchMove);
  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const drag = createPointerDrag({
    onStart: (e) => {
      mode.set('pending');
      samples = [{ t: e.timeStamp, y: e.clientX }];
      if (!canReorder(e)) return;
      timer = setTimeout(() => {
        timer = null;
        if (mode() !== 'pending') return;
        mode.set('reorder');
        document.addEventListener('touchmove', blockTouchMove, { passive: false });
        options.onReorderStart?.();
      }, longPressMs);
    },
    onMove: (e, start) => {
      const dx = e.clientX - start.clientX;
      const dy = e.clientY - start.clientY;
      const current = mode();
      if (current === 'pending') {
        if (Math.abs(dx) < SWIPE_SLOP_PX && Math.abs(dy) < SWIPE_SLOP_PX) return;
        clearTimer();
        if (Math.abs(dx) <= Math.abs(dy)) {
          // A plain pan: the list's scroll, not ours.
          reset();
          drag.cancel();
          return;
        }
        mode.set('swipe');
      }
      if (mode() === 'swipe') {
        samples.push({ t: e.timeStamp, y: e.clientX });
        options.onSwipeMove?.(dx);
      } else if (mode() === 'reorder') {
        options.onReorderMove?.(dy, e);
      }
    },
    onEnd: (e, start) => finish(e, start, false),
    onCancel: (e, start) => finish(e, start, true),
  });

  const reset = (): void => {
    clearTimer();
    removeBlocker();
    samples = [];
    mode.set('idle');
  };

  const finish = (e: PointerEvent, start: PointerEvent, cancelled: boolean): void => {
    const ended = mode();
    if (ended === 'swipe') samples.push({ t: e.timeStamp, y: e.clientX });
    const velocity = ended === 'swipe' ? flickVelocity(samples) : 0;
    reset();
    if (ended === 'swipe') {
      options.onSwipeEnd?.({ dx: e.clientX - start.clientX, velocity, cancelled });
    } else if (ended === 'reorder') {
      options.onReorderEnd?.({ dy: e.clientY - start.clientY, cancelled });
    }
  };

  inject(DestroyRef).onDestroy(reset);

  return { mode: mode.asReadonly(), start: drag.start };
}

/**
 * The index a lifted row lands on under remove-then-insert (`moveInList`)
 * semantics: how many of the *other* rows' midpoints sit above the dragged
 * row's centre. `mids` are the rows' resting vertical midpoints in list order.
 */
export function reorderTargetIndex(mids: readonly number[], from: number, dy: number): number {
  const centre = mids[from]! + dy;
  let target = 0;
  for (let i = 0; i < mids.length; i++) {
    if (i !== from && mids[i]! < centre) target++;
  }
  return target;
}
