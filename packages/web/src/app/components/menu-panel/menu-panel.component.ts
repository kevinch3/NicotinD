import {
  Component,
  ElementRef,
  HostListener,
  effect,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { computeMenuPosition } from '../../lib/menu-position';

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

  private reposition(): void {
    const triggerEl = this.trigger()?.nativeElement;
    const panelEl = this.panel()?.nativeElement;
    if (!triggerEl || !panelEl) return;
    const r = triggerEl.getBoundingClientRect();
    const p = panelEl.getBoundingClientRect();
    this.pos.set(
      computeMenuPosition(r, p.width, p.height, window.innerWidth, window.innerHeight, this.align()),
    );
    this.positioned.set(true);
  }

  toggle(event: Event): void {
    event.stopPropagation();
    this.open.update((v) => !v);
  }

  close(): void {
    this.open.set(false);
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
}
