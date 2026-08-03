import {
  AfterViewInit,
  Directive,
  ElementRef,
  HostListener,
  OnDestroy,
  inject,
} from '@angular/core';
import { measureBottomChromeInset } from '../lib/player-chrome';

/**
 * Reserves space for the fixed bottom chrome (mini-player + mobile tab bar) at
 * the bottom of a full-screen modal backdrop (`fixed inset-0 z-50 flex
 * justify-center …`), so a centered dialog never renders its last content
 * underneath the higher-z-index, opaque chrome (issue #367 — the Changelog and
 * artist genre-fix modals were both confirmed cut off while a track was
 * playing).
 *
 * Reuses the same `measureBottomChromeInset`/`[data-bottom-chrome]` primitive
 * `MenuPanelComponent` uses for popovers (see docs/design-patterns.md
 * "Viewport-safe dropdown menus"), rather than re-deriving the chrome height.
 *
 * Applied to the backdrop, not the dialog itself:
 * - `padding-bottom` grows by the measured inset (added on top of whatever
 *   padding the component already had, captured once on init) — a short
 *   dialog is simply centered higher, clear of the reserved zone.
 * - `overflow-y: auto` makes the backdrop the scrollport for a dialog taller
 *   than the available space; `overscroll-behavior: contain` keeps that scroll
 *   from chaining into the page behind the modal.
 * - `--bottom-chrome-inset` is published on the backdrop so the dialog panel
 *   can self-bound with the canonical recipe
 *   `max-h-[calc(100dvh-var(--bottom-chrome-inset,0px)-<static padding>)]`
 *   (see docs/design-patterns.md "Bottom-chrome-safe modals").
 *
 * Re-measure triggers, all funnelled into `reposition()`:
 * - `window:resize` — viewport/orientation changes.
 * - a `ResizeObserver` on the backdrop *and* its first child (the dialog
 *   panel) — a panel that grows after async content lands (the genre modal's
 *   radar charts) used to keep the stale first measurement. Guarded because
 *   jsdom has no ResizeObserver.
 * - `transitionend` bubbling from a `[data-bottom-chrome]` layer — the
 *   mini-player shows/hides via a transform transition, which never changes
 *   any observed element's box, so neither trigger above sees it.
 */
@Directive({
  selector: '[appBottomChromeSafe]',
  standalone: true,
})
export class BottomChromeSafeDirective implements AfterViewInit, OnDestroy {
  private readonly el = inject(ElementRef<HTMLElement>);
  private basePaddingBottom = 0;
  private resizeObserver: ResizeObserver | null = null;

  ngAfterViewInit(): void {
    const host = this.el.nativeElement;
    this.basePaddingBottom = parseFloat(getComputedStyle(host).paddingBottom) || 0;
    host.style.overflowY = 'auto';
    host.style.overscrollBehavior = 'contain';
    this.reposition();

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.reposition());
      this.resizeObserver.observe(host);
      if (host.firstElementChild) this.resizeObserver.observe(host.firstElementChild);
    }
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  @HostListener('document:transitionend', ['$event'])
  onChromeTransitionEnd(event: Event): void {
    if ((event.target as Element | null)?.closest?.('[data-bottom-chrome]')) this.reposition();
  }

  @HostListener('window:resize')
  reposition(): void {
    const host = this.el.nativeElement;
    const inset = measureBottomChromeInset();
    host.style.paddingBottom = `${this.basePaddingBottom + inset}px`;
    host.style.setProperty('--bottom-chrome-inset', `${inset}px`);
  }
}
