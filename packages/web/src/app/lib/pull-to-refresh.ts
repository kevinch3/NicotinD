/**
 * createPullToRefresh — the touch pull-down-to-refresh gesture, composed on
 * createPointerDrag. The caller (layout shell) binds `onPointerDown` on the
 * scrollable content and renders an indicator off `phase`/`pullPx`.
 *
 * From pointerdown a non-passive document `touchmove` listener preventDefault()s
 * downward-dominant moves (dy > 0 and dy >= |dx|): touch browsers reclaim an
 * unprevented vertical pan after ~10px, fire pointercancel and stop sending
 * moves, and once a scroll is in progress touchmove arrives non-cancelable —
 * so the FIRST touchmove is the only winnable round, and the blocker must be
 * armed before it (attaching on pull intent, after slop, always lost; that was
 * the bug that made the gesture dead on real devices). Overscroll-behavior does
 * NOT prevent the reclaim — it only suppresses the navigation/glow effect. The
 * dominance test keeps horizontal pans (tab strips) native. This is the
 * sanctioned home for that wiring; see docs/web-ui.md "Pull to refresh".
 *
 * A pointercancel while armed COMMITS the refresh — on touch, never rely on a
 * clean pointerup (same lesson as the player swipe-up).
 *
 * Must be called within an injection context.
 */
import { DestroyRef, inject, signal, type Signal } from '@angular/core';
import { createPointerDrag } from './pointer-drag';

export const PULL_SLOP_PX = 10;
export const PULL_THRESHOLD_PX = 70;
export const PULL_MAX_PX = 120;

/** Diminishing-returns damping: raw finger travel → indicator px, capped at PULL_MAX_PX. */
export function dampPull(rawPx: number): number {
  if (rawPx <= 0) return 0;
  return PULL_MAX_PX * (1 - Math.exp(-rawPx / PULL_MAX_PX));
}

export type PullPhase = 'idle' | 'pulling' | 'armed' | 'refreshing';

export interface PullToRefreshOptions {
  /** Runs on release/cancel while armed; `phase` holds 'refreshing' until it settles. */
  onRefresh: () => Promise<void> | void;
  /** Extra pointerdown gate (coarse pointer, scroll lock, handler presence). */
  canStart?: () => boolean;
}

export interface PullToRefresh {
  readonly phase: Signal<PullPhase>;
  readonly pullPx: Signal<number>;
  /** Bind to `(pointerdown)` on the scrollable content wrapper. */
  onPointerDown: (e: PointerEvent) => void;
}

const NON_PULL_TARGETS = 'input,textarea,select,[data-no-p2r]';

export function createPullToRefresh(options: PullToRefreshOptions): PullToRefresh {
  const phase = signal<PullPhase>('idle');
  const pullPx = signal(0);
  let intent: 'undecided' | 'pull' | 'scroll' = 'undecided';
  let startPoint: { x: number; y: number } | null = null;

  const blockTouchMove = (e: TouchEvent): void => {
    if (intent === 'scroll' || !e.cancelable) return;
    if (intent === 'pull') {
      e.preventDefault();
      return;
    }
    // Undecided: the first move's direction decides — dominance mirrors onMove's
    // intent test, but can't wait for slop (see header).
    const t = e.touches[0];
    if (!t || !startPoint) return;
    const dy = t.clientY - startPoint.y;
    const dx = t.clientX - startPoint.x;
    if (dy > 0 && dy >= Math.abs(dx)) e.preventDefault();
  };
  const attachBlocker = (): void =>
    document.addEventListener('touchmove', blockTouchMove, { passive: false });
  const removeBlocker = (): void => document.removeEventListener('touchmove', blockTouchMove);

  const settle = (): void => {
    removeBlocker();
    intent = 'undecided';
    startPoint = null;
    if (phase() !== 'refreshing') {
      phase.set('idle');
      pullPx.set(0);
    }
  };

  const commit = (): void => {
    removeBlocker();
    intent = 'undecided';
    startPoint = null;
    phase.set('refreshing');
    pullPx.set(PULL_THRESHOLD_PX);
    let result: Promise<void> | void;
    try {
      result = options.onRefresh();
    } catch {
      result = undefined;
    }
    void Promise.resolve(result)
      .catch(() => undefined)
      .finally(() => {
        phase.set('idle');
        pullPx.set(0);
      });
  };

  const finish = (): void => {
    if (phase() === 'armed') commit();
    else settle();
  };

  const drag = createPointerDrag({
    onStart: (e) => {
      startPoint = { x: e.clientX, y: e.clientY };
      attachBlocker();
    },
    onMove: (e, start) => {
      if (intent === 'scroll') return;
      const dy = e.clientY - start.clientY;
      const dx = e.clientX - start.clientX;
      if (intent === 'undecided') {
        if (Math.abs(dy) < PULL_SLOP_PX && Math.abs(dx) < PULL_SLOP_PX) return;
        if (dy > 0 && dy > Math.abs(dx)) {
          intent = 'pull';
        } else {
          intent = 'scroll';
          return;
        }
      }
      const damped = dampPull(dy - PULL_SLOP_PX);
      pullPx.set(damped);
      phase.set(damped >= PULL_THRESHOLD_PX ? 'armed' : 'pulling');
    },
    onEnd: finish,
    onCancel: finish,
  });

  const onPointerDown = (e: PointerEvent): void => {
    if (phase() !== 'idle') return;
    if (e.isPrimary === false || e.pointerType === 'mouse') return;
    if (window.scrollY > 0) return;
    if ((e.target as Element | null)?.closest?.(NON_PULL_TARGETS)) return;
    if (options.canStart && !options.canStart()) return;
    drag.start(e);
  };

  inject(DestroyRef).onDestroy(removeBlocker);

  return { phase, pullPx, onPointerDown };
}
