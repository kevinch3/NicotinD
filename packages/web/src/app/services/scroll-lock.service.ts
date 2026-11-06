import { Injectable } from '@angular/core';
import { scrollRootElement } from '../lib/scroll-root';

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
  private targets: HTMLElement[] = [];
  private prev: [string, string][] = [];

  /** Whether the document is currently locked (≥1 holder). Exposed for tests. */
  get locked(): boolean {
    return this.count > 0;
  }

  lock(): void {
    this.count += 1;
    if (this.count > 1) return;
    // The page scrolls inside the shell's <main>, so lock that as well as the root.
    this.targets = [document.documentElement, scrollRootElement()].filter(
      (e): e is HTMLElement => !!e,
    );
    this.prev = this.targets.map((el) => [el.style.overflow, el.style.overscrollBehavior]);
    for (const el of this.targets) {
      el.style.overflow = 'hidden';
      el.style.overscrollBehavior = 'none';
    }
  }

  unlock(): void {
    if (this.count === 0) return;
    this.count -= 1;
    if (this.count > 0) return;
    this.targets.forEach((el, i) => {
      el.style.overflow = this.prev[i][0];
      el.style.overscrollBehavior = this.prev[i][1];
    });
    this.targets = [];
    this.prev = [];
  }
}
