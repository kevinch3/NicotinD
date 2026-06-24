import { Injectable } from '@angular/core';

/**
 * Ref-counted document scroll lock for full-screen overlays.
 *
 * A `position: fixed; inset: 0` sheet (Now Playing) paints over the page, but
 * the document underneath still scrolls/overscrolls on touch — so flinging the
 * sheet moved the backgrounded list behind it. While ≥1 lock is held this pins
 * the document (`overflow: hidden` + `overscroll-behavior: none` on the root)
 * so the background can't move. Ref-counting keeps nested overlays independent:
 * an add-to-playlist sheet opened *from* Now Playing locks separately, and the
 * background only frees when the last holder releases. Previous inline styles
 * are restored on full release so nothing leaks.
 */
@Injectable({ providedIn: 'root' })
export class ScrollLockService {
  private count = 0;
  private prevOverflow = '';
  private prevOverscroll = '';

  /** Whether the document is currently locked (≥1 holder). Exposed for tests. */
  get locked(): boolean {
    return this.count > 0;
  }

  lock(): void {
    this.count += 1;
    if (this.count > 1) return;
    const el = document.documentElement;
    this.prevOverflow = el.style.overflow;
    this.prevOverscroll = el.style.overscrollBehavior;
    el.style.overflow = 'hidden';
    el.style.overscrollBehavior = 'none';
  }

  unlock(): void {
    if (this.count === 0) return;
    this.count -= 1;
    if (this.count > 0) return;
    const el = document.documentElement;
    el.style.overflow = this.prevOverflow;
    el.style.overscrollBehavior = this.prevOverscroll;
  }
}
