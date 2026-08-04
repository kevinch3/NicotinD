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
import { computeMenuPosition } from '../../lib/menu-position';
import { measureBottomChromeInset } from '../../lib/player-chrome';
import { BackButtonService } from '../../services/native/back-button.service';

/**
 * Reusable dropdown/popover panel anchored to a projected trigger, positioned
 * with `computeMenuPosition` so it's always **fully inside the viewport** — the
 * fix for filter/context menus that used a bare `absolute right-0` and spilled
 * off-screen on narrow viewports. Project the trigger with `[menuTrigger]` and
 * the panel body with `[menuPanel]`.
 *
 * The panel renders `position: fixed` and is measured after it mounts, then the
 * top-left is set + clamped (and flips above the trigger when there's no room
 * below). It stays `visibility:hidden` for the one frame before it's measured to
 * avoid a flash at the wrong spot.
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
   *  under the JIT test harness's plain `detectChanges` too. */
  ngAfterViewChecked(): void {
    if (this.open() && !this.autofocused) {
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
    const r = triggerEl.getBoundingClientRect();
    const p = panelEl.getBoundingClientRect();
    // Reserve the fixed bottom chrome (mini-player + tab bar) so the panel flips
    // up / clamps above it instead of opening under it — the mobile bug where a
    // track-row menu near the list end was hidden behind the player.
    const inset = measureBottomChromeInset();
    this.pos.set(
      computeMenuPosition(
        r,
        p.width,
        p.height,
        window.innerWidth,
        window.innerHeight,
        this.align(),
        undefined,
        undefined,
        inset,
      ),
    );
    this.positioned.set(true);
  }

  private readonly backButton = inject(BackButtonService);
  private unregisterBack: (() => void) | null = null;

  toggle(event: Event): void {
    event.stopPropagation();
    this.open.update((v) => !v);
    if (this.open()) {
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
  @HostListener('document:keydown.escape') onEsc(): void {
    this.close();
  }
  @HostListener('window:resize') onResize(): void {
    if (this.open()) this.reposition();
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
