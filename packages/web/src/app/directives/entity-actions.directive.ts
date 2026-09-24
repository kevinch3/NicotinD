import { Directive, ElementRef, Injector, Input, inject } from '@angular/core';
import type { TrackAction } from '../components/track-row/track-row.component';
import { isTvUi } from '../lib/platform';
import { EntityMenuService } from '../services/entity-menu.service';

/** A hold this long opens the menu; shorter is a tap. Matches the mosaic's old press. */
export const HOLD_MS = 450;
/** Finger travel past this during a hold makes it a pan instead. */
export const HOLD_SLOP_PX = 10;

/**
 * The two pointer doors into a tile's menu (issue #1298): **right-click** opens
 * it at the pointer, and a **touch hold** (≈450ms, still) opens it at the
 * finger and eats the click the release would fire. The third door, hover,
 * is the sibling `<app-entity-menu-button>`. Actions are a factory so a grid
 * of tiles builds a menu only when one is asked for.
 *
 * A press that starts on a control inside the tile (a button, a link that is
 * not the tile itself) belongs to that control. A mouse press is never a hold:
 * desktop has hover and right-click. Nothing happens on TV, where a D-pad
 * long-press is a different contract.
 */
@Directive({
  selector: '[appEntityActions]',
  standalone: true,
  host: {
    '(contextmenu)': 'onContextMenu($event)',
    '(pointerdown)': 'onPointerDown($event)',
    '(pointermove)': 'onPointerMove($event)',
    '(pointerup)': 'cancelHold()',
    '(pointercancel)': 'cancelHold()',
  },
})
export class EntityActionsDirective {
  // A classic `@Input`, like `appTvNavGroup`'s `axis`: the JIT test harness does
  // not discover `input()` fields on directives (src/testing/signal-input.ts).
  @Input({ alias: 'appEntityActions' }) actions: () => TrackAction[] = () => [];

  // Resolved when a menu is asked for, so a page that renders a hundred tiles
  // never instantiates the menu's dependency graph just to render them.
  private readonly injector = inject(Injector);
  private get menu(): EntityMenuService {
    return this.injector.get(EntityMenuService);
  }
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private origin: { x: number; y: number } | null = null;
  private suppressClick = false;

  constructor() {
    // Capture-phase, so it runs before the tile's own click handler and can
    // stop it: the release after a hold must not also open the tile.
    this.host.addEventListener(
      'click',
      (e) => {
        if (!this.suppressClick) return;
        this.suppressClick = false;
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      { capture: true },
    );
  }

  onContextMenu(e: MouseEvent): void {
    if (isTvUi()) return;
    e.preventDefault();
    this.menu.open({ actions: this.actions(), at: { x: e.clientX, y: e.clientY } });
  }

  onPointerDown(e: PointerEvent): void {
    if (isTvUi() || e.pointerType === 'mouse' || e.isPrimary === false) return;
    if (this.ownedByInnerControl(e.target)) return;
    this.cancelHold();
    const at = { x: e.clientX, y: e.clientY };
    this.origin = at;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.origin = null;
      this.suppressClick = true;
      this.menu.open({ actions: this.actions(), at });
    }, HOLD_MS);
  }

  onPointerMove(e: PointerEvent): void {
    if (!this.origin) return;
    if (
      Math.abs(e.clientX - this.origin.x) > HOLD_SLOP_PX ||
      Math.abs(e.clientY - this.origin.y) > HOLD_SLOP_PX
    ) {
      this.cancelHold();
    }
  }

  cancelHold(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.origin = null;
  }

  private ownedByInnerControl(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    const control = target.closest('button, a, input, select, textarea, [data-entity-menu-button]');
    return control !== null && control !== this.host;
  }
}
