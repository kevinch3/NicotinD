import { AfterViewInit, Directive, ElementRef, HostListener, inject } from '@angular/core';
import { measureBottomChromeInset } from '../lib/player-chrome';

/**
 * Reserves space for the fixed bottom chrome (mini-player + mobile tab bar) at
 * the bottom of a full-screen modal backdrop (`fixed inset-0 z-50 flex
 * items-center justify-center …`), so a centered dialog never renders its last
 * content underneath the higher-z-index, opaque chrome (issue #367 — the
 * Changelog and artist genre-fix modals were both confirmed cut off while a
 * track was playing).
 *
 * Reuses the same `bottomChromeInset`/`[data-bottom-chrome]` primitive
 * `MenuPanelComponent` uses for popovers (see docs/design-patterns.md
 * "Viewport-safe dropdown menus"), rather than re-deriving the chrome height.
 *
 * The fix is two parts working together, both applied to the backdrop, not
 * the dialog itself:
 * - `padding-bottom` grows by the measured inset (added on top of whatever
 *   padding the component already had, captured once on init) — a short
 *   dialog is simply centered higher, clear of the reserved zone.
 * - `overflow-y: auto` makes the backdrop the scrollport for a dialog taller
 *   than the available space. Because the reserved padding is part of that
 *   scrollport's content box, scrolling to the very end always stops with the
 *   dialog's last content sitting just above the chrome rather than under it —
 *   one mechanism handles both "fits" and "needs to scroll" without touching
 *   each modal's own `max-h-[Xvh]` markup individually.
 */
@Directive({
  selector: '[appBottomChromeSafe]',
  standalone: true,
})
export class BottomChromeSafeDirective implements AfterViewInit {
  private readonly el = inject(ElementRef<HTMLElement>);
  private basePaddingBottom = 0;

  ngAfterViewInit(): void {
    const host = this.el.nativeElement;
    this.basePaddingBottom = parseFloat(getComputedStyle(host).paddingBottom) || 0;
    host.style.overflowY = 'auto';
    this.reposition();
  }

  @HostListener('window:resize')
  reposition(): void {
    const host = this.el.nativeElement;
    const inset = measureBottomChromeInset();
    host.style.paddingBottom = `${this.basePaddingBottom + inset}px`;
  }
}
