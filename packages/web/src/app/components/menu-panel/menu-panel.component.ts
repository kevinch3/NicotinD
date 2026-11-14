import {
  Component,
  ElementRef,
  HostListener,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import {
  computeMenuPosition,
  menuMaxHeight,
  menuPresentation,
  menuSheetLayout,
  type MenuPresentation,
} from '../../lib/menu-position';
import { measureBottomChromeInset, measureTopChromeInset } from '../../lib/player-chrome';
import { isTvUi } from '../../lib/platform';
import { BackButtonService } from '../../services/native/back-button.service';

/**
 * Reusable dropdown/popover panel anchored to a projected trigger, positioned
 * with `computeMenuPosition` so it's always **fully inside the viewport** — the
 * fix for filter/context menus that used a bare `absolute right-0` and spilled
 * off-screen on narrow viewports. Project the trigger with `[menuTrigger]` and
 * the panel body with `[menuPanel]`.
 *
 * **Those two attribute names are exact, and getting one wrong fails silently.**
 * There is no catch-all `<ng-content>`, so content carrying any other attribute is
 * dropped: it renders nowhere, and typecheck, lint, Storybook and the host
 * component's own spec all stay green. `ArtistImageMenuComponent` shipped with
 * `trigger` instead of `menuTrigger`, which left the artist-photo edit control
 * invisible on the artist page and on every Artists-grid tile — behind a 14-case
 * suite that passed, because every case drove the component class and none
 * asserted the DOM. `menu-panel-projection.spec.ts` is the drift guard that now
 * scans every call site for both slots.
 *
 * The panel renders `position: fixed` and is measured after it mounts, then the
 * top-left is set + clamped between the top reservation (status bar + header)
 * and the bottom chrome (and flips above the trigger when there's no room
 * below); a panel taller than that band scrolls inside it. It stays
 * `visibility:hidden` for the one frame before it's measured to avoid a flash
 * at the wrong spot.
 *
 * **On a phone it is a bottom action sheet instead** (#1714, `menuPresentation`):
 * full width, sitting on the bottom chrome (or the screen bottom inside Now
 * Playing, which covers the chrome), with a dimming backdrop. The thumb reaches
 * every item wherever the trigger was; the anchored popover put a long song
 * menu's first items under the status bar. The panel stays in place in the
 * DOM, so scoped `row.getByTestId(...)` selectors and the D-pad wiring are the
 * same in both modes. docs/design-patterns.md "Reachable menus".
 */
@Component({
  selector: 'app-menu-panel',
  templateUrl: './menu-panel.component.html',
})
export class MenuPanelComponent {
  /** Anchor edge: 'end' right-aligns under the trigger (default), 'start' left. */
  readonly align = input<'start' | 'end'>('end');
  readonly panelTestId = input<string | undefined>(undefined);

  readonly open = signal(false);
  readonly pos = signal<{ x: number; y: number }>({ x: -9999, y: -9999 });
  readonly positioned = signal(false);
  /** Popover anchored to the trigger, or the phone's bottom sheet. Chosen per open. */
  readonly presentation = signal<MenuPresentation>('popover');
  /** Sheet only: distance from the viewport bottom (the top of the visible bottom chrome). */
  readonly sheetBottom = signal(0);
  /** Set when the panel must scroll inside the band between the reservations. */
  readonly maxHeight = signal<number | null>(null);

  private trigger = viewChild<ElementRef<HTMLElement>>('trigger');
  private panel = viewChild<ElementRef<HTMLElement>>('panelEl');

  constructor() {
    // Once open and the panel has mounted, measure both and place it clamped.
    effect(() => {
      if (this.open() && this.panel()) this.reposition();
      else this.positioned.set(false);
    });
  }

  private autofocused = false;

  /** D-pad/keyboard support (issue #389): focus the first action once the
   *  panel has rendered, so a remote user lands inside the menu instead of on
   *  a spatial-nav lottery. A lifecycle hook rather than the effect above:
   *  idempotent, writes no signals, and — unlike injector effects — runs
   *  under the JIT test harness's plain `detectChanges` too. Waits for
   *  `positioned`: the panel is `visibility:hidden` until then, and `focus()`
   *  on a hidden element is a no-op (#1862). */
  ngAfterViewChecked(): void {
    if (this.open() && this.positioned() && !this.autofocused) {
      const first = this.panelButtons()[0];
      if (first) {
        this.autofocused = true;
        first.focus();
      }
    } else if (!this.open()) {
      this.autofocused = false;
    }
  }

  // The two D-pad paths query the host DOM directly rather than the
  // `viewChild()` signals: signal view queries never populate under this
  // project's JIT vitest harness (the same limitation as `input()` — see the
  // spec header), and the panel/trigger are plain DOM descendants of the
  // host either way.
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);

  private panelRootEl(): HTMLElement | null {
    return this.host.nativeElement.querySelector<HTMLElement>('[data-menu-panel-root]');
  }

  private panelButtons(): HTMLElement[] {
    const panelEl = this.panelRootEl();
    return panelEl
      ? Array.from(panelEl.querySelectorAll<HTMLElement>('button:not([disabled])'))
      : [];
  }

  private reposition(): void {
    const triggerEl = this.trigger()?.nativeElement;
    const panelEl = this.panel()?.nativeElement;
    if (!triggerEl || !panelEl) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Reserve the fixed bottom chrome (mini-player + tab bar) and the status
    // bar + header, measured from this menu's own place in the DOM: inside Now
    // Playing both are covered, so neither is reserved.
    const host = this.host.nativeElement;
    const bottomInset = measureBottomChromeInset(host);
    const topInset = measureTopChromeInset(host);
    const presentation = menuPresentation(vw, isTvUi());
    this.presentation.set(presentation);

    if (presentation === 'sheet') {
      const sheet = menuSheetLayout(vh, topInset, bottomInset);
      this.sheetBottom.set(sheet.bottom);
      this.maxHeight.set(sheet.maxHeight);
      this.positioned.set(true);
      return;
    }

    const r = triggerEl.getBoundingClientRect();
    const p = panelEl.getBoundingClientRect();
    // scrollHeight is the natural height even while a previous max-height caps the box.
    const natural = Math.max(p.height, panelEl.scrollHeight);
    const band = menuMaxHeight(vh, topInset, bottomInset);
    const height = Math.min(natural, band);
    this.maxHeight.set(natural > band ? band : null);
    this.pos.set(
      computeMenuPosition(
        r,
        p.width,
        height,
        vw,
        vh,
        this.align(),
        undefined,
        undefined,
        bottomInset,
        topInset,
      ),
    );
    this.positioned.set(true);
  }

  /** The sheet's `bottom`: on the chrome, or on the real screen bottom (iOS deficit). */
  sheetBottomCss(): string {
    const inset = this.sheetBottom();
    return inset > 0 ? `${inset}px` : 'calc(-1 * var(--vp-deficit, 0px))';
  }

  /** A tap on the sheet's backdrop closes it, and is nobody else's tap: an
   *  ancestor may stop clicks (artist image menu) or act on them (a card). */
  onBackdropClick(event: Event): void {
    event.stopPropagation();
    this.close();
  }

  private readonly backButton = inject(BackButtonService);
  private unregisterBack: (() => void) | null = null;

  toggle(event: Event): void {
    event.stopPropagation();
    this.open.update((v) => !v);
    if (this.open()) {
      // Decided before the first (hidden) render, so the popover is measured
      // at its own size and never at a stale sheet's full width.
      this.presentation.set(menuPresentation(window.innerWidth, isTvUi()));
      this.maxHeight.set(null);
      // Hardware Back closes the open menu first (issue #394).
      this.unregisterBack ??= this.backButton.stack.push(() => {
        this.close();
        return true;
      });
    } else {
      this.unregisterBack?.();
      this.unregisterBack = null;
    }
  }

  close(): void {
    // Focus-restore (issue #389): a D-pad user whose focus lives inside the
    // panel must land back on the trigger, not be dropped to <body>. Only
    // when focus is actually inside the panel — an outside click has already
    // moved focus to whatever was clicked, and stealing it back would be
    // wrong.
    const panelEl = this.panelRootEl();
    const restore = !!panelEl && panelEl.contains(document.activeElement);
    this.open.set(false);
    this.unregisterBack?.();
    this.unregisterBack = null;
    if (restore) {
      const trigger = this.host.nativeElement.querySelector<HTMLElement>('[data-menu-trigger]');
      (trigger?.querySelector<HTMLElement>('button, a, [tabindex]') ?? trigger)?.focus();
    }
  }

  // Outside-click / Escape close (the trigger's stopPropagation keeps the opening
  // click from immediately closing it).
  @HostListener('document:click') onDocClick(): void {
    this.close();
  }
  /** The mini-player slides in on a transform transition, which moves its top
   *  edge without resizing anything: a menu opened mid-slide re-measures when it
   *  settles, or a sheet would end a few px under the bar (the same trigger
   *  `BottomChromeSafeDirective` listens for). */
  @HostListener('document:transitionend', ['$event']) onChromeTransitionEnd(event: Event): void {
    if (this.open() && (event.target as Element | null)?.closest?.('[data-bottom-chrome]')) {
      this.reposition();
    }
  }
  @HostListener('window:resize') onResize(): void {
    if (!this.open()) return;
    // A rotation that crosses the phone breakpoint changes what the menu is;
    // close rather than morph a sheet into a popover mid-gesture.
    if (menuPresentation(window.innerWidth, isTvUi()) !== this.presentation()) this.close();
    else this.reposition();
  }

  /** ArrowUp/Down move between the panel's actions (clamped, no wrap) while
   *  open — and the event is stopped so an ancestor `appTvNavGroup` (e.g. the
   *  track list behind the open menu) never navigates underneath it. */
  @HostListener('keydown', ['$event']) onKeydown(event: KeyboardEvent): void {
    if (!this.open()) return;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = this.panelButtons();
    if (buttons.length === 0) return;
    const current = buttons.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === 'ArrowDown'
        ? Math.min(current + 1, buttons.length - 1)
        : Math.max(current - 1, 0);
    event.preventDefault();
    event.stopPropagation();
    buttons[next]?.focus();
  }
}
