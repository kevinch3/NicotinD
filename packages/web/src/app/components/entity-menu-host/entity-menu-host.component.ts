import { Component, HostListener, computed, effect, inject, signal } from '@angular/core';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { EntityMenuService } from '../../services/entity-menu.service';
import { BackButtonService } from '../../services/native/back-button.service';
import {
  clampMenuPosition,
  menuMaxHeight,
  menuPresentation,
  menuSheetLayout,
  type Point,
} from '../../lib/menu-position';
import { measureBottomChromeInset, measureTopChromeInset } from '../../lib/player-chrome';
import { isTvUi } from '../../lib/platform';
import type { TrackAction } from '../track-row/track-row.component';

const MENU_WIDTH = 200;
/**
 * A hold opens the menu under the finger, so the release that follows lands
 * on the panel and the browser dispatches its click to the common ancestor of
 * tile and panel — above both of their listeners, straight to this host's
 * outside-click. An outside click this soon after opening is that release.
 */
export const OPEN_GRACE_MS = 350;
const ITEM_HEIGHT = 36;
const ANCHOR_GAP = 4;

export type EntityMenuLayout =
  | { kind: 'popover'; x: number; y: number; maxHeight: number | null }
  | { kind: 'sheet'; bottom: number; maxHeight: number };

/**
 * The one entity menu (issue #1298), mounted once in the layout like the
 * confirm and track-info hosts. Tiles never carry a panel of their own: they
 * call `EntityMenuService.open()` with a pointer point (right-click, hold) or
 * an anchor (their ⋯ button), and this renders it — clamped into the viewport
 * between the status bar + header and the bottom chrome, closed by Escape, an
 * outside click, hardware Back, or running an item. On a phone it is the same
 * bottom action sheet `MenuPanelComponent` becomes (#1714, `menuPresentation`):
 * a hold anywhere on the screen opens it at the thumb's edge, not under the
 * finger.
 */
@Component({
  selector: 'app-entity-menu-host',
  standalone: true,
  imports: [TranslatePipe],
  templateUrl: './entity-menu-host.component.html',
})
export class EntityMenuHostComponent {
  readonly menu = inject(EntityMenuService);
  private readonly back = inject(BackButtonService);

  readonly state = this.menu.state;

  /** Bumped when the bottom chrome finishes a transition, so the layout re-measures. */
  private readonly chromeMoved = signal(0);

  readonly layout = computed<EntityMenuLayout | null>(() => {
    const s = this.state();
    if (!s) return null;
    this.chromeMoved();
    const vh = window.innerHeight;
    const bottomInset = measureBottomChromeInset(s.anchor);
    const topInset = measureTopChromeInset(s.anchor);
    if (menuPresentation(window.innerWidth, isTvUi()) === 'sheet') {
      const sheet = menuSheetLayout(vh, topInset, bottomInset);
      return { kind: 'sheet', bottom: sheet.bottom, maxHeight: sheet.maxHeight };
    }
    const natural = s.actions.length * ITEM_HEIGHT + 8;
    const band = menuMaxHeight(vh, topInset, bottomInset);
    const height = Math.min(natural, band);
    const raw: Point = s.anchor ? anchorPoint(s.anchor) : (s.at ?? { x: 0, y: 0 });
    const at = clampMenuPosition(
      raw,
      window.innerWidth,
      vh,
      MENU_WIDTH,
      height,
      8,
      bottomInset,
      topInset,
    );
    return { kind: 'popover', x: at.x, y: at.y, maxHeight: natural > band ? band : null };
  });

  /** The sheet's `bottom`: on the chrome, or on the real screen bottom (iOS deficit). */
  sheetBottomCss(bottom: number): string {
    return bottom > 0 ? `${bottom}px` : 'calc(-1 * var(--vp-deficit, 0px))';
  }

  constructor() {
    effect((onCleanup) => {
      if (!this.state()) return;
      const unregister = this.back.stack.push(() => {
        this.menu.close();
        return true;
      });
      onCleanup(unregister);
    });
  }

  run(action: TrackAction): void {
    this.menu.close();
    action.action();
  }

  @HostListener('document:keydown', ['$event'])
  onKeydown(e: KeyboardEvent): void {
    if (!this.state()) return;
    if (e.key === 'Escape') {
      this.menu.close();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const items = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[data-testid="entity-menu"] button'),
      );
      if (items.length === 0) return;
      e.preventDefault();
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
      items[next].focus();
    }
  }

  /** The mini-player slides in on a transform transition: re-measure once it settles. */
  @HostListener('document:transitionend', ['$event'])
  onChromeTransitionEnd(e: Event): void {
    if (this.state() && (e.target as Element | null)?.closest?.('[data-bottom-chrome]')) {
      this.chromeMoved.update((n) => n + 1);
    }
  }

  @HostListener('document:click')
  onDocumentClick(): void {
    if (!this.state()) return;
    if (performance.now() - this.menu.openedAt < OPEN_GRACE_MS) return;
    this.menu.close();
  }
}

function anchorPoint(anchor: HTMLElement): Point {
  const r = anchor.getBoundingClientRect();
  // Right-align under the button, like the track row's ⋯ (`align="end"`).
  return { x: r.right - MENU_WIDTH, y: r.bottom + ANCHOR_GAP };
}
