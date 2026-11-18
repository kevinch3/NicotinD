import {
  Component,
  ElementRef,
  EventEmitter,
  HostBinding,
  HostListener,
  Input,
  OnDestroy,
  Injector,
  Output,
  afterNextRender,
  inject,
  signal,
} from '@angular/core';
import { MenuItemComponent } from '../menu-item/menu-item.component';
import { CoverArtComponent } from '../cover-art/cover-art.component';
import { IconComponent } from '../icon/icon.component';
import { OverflowRevealDirective } from '../../directives/overflow-reveal.directive';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { startsGroup } from '../../lib/menu-groups';
import { BackButtonService } from '../../services/native/back-button.service';
import { measureBottomChromeInset, measureTopChromeInset } from '../../lib/player-chrome';
import type { TrackAction } from '../track-row/track-row.component';

/** Width a flyout needs beside its row before it flips to the other side. */
export const FLYOUT_WIDTH_PX = 224;

/**
 * Which side of its parent row a flyout opens on: the right, unless it would
 * leave the viewport there and fits on the left.
 */
export function flyoutSide(
  row: { left: number; right: number },
  viewportWidth: number,
  width = FLYOUT_WIDTH_PX,
): 'right' | 'left' {
  if (row.right + width <= viewportWidth) return 'right';
  return row.left - width >= 0 ? 'left' : 'right';
}

/** Space a flyout keeps from the chrome it is lifted clear of. */
const FLYOUT_MARGIN_PX = 8;

/**
 * How far to lift a flyout so it ends above the bottom chrome (the player
 * bar): by its overflow, but never so far that its top goes under the header.
 */
export function flyoutShift(
  flyout: { top: number; bottom: number },
  viewportHeight: number,
  bottomInset: number,
  topInset: number,
  margin = FLYOUT_MARGIN_PX,
): number {
  const overflow = flyout.bottom - (viewportHeight - bottomInset - margin);
  if (overflow <= 0) return 0;
  return Math.max(0, Math.min(overflow, flyout.top - topInset - margin));
}

/** Rows of a list after a filter field's text is applied; field rows always stay. */
export function filterRows(rows: readonly TrackAction[], text: string): TrackAction[] {
  const needle = text.trim().toLocaleLowerCase();
  if (!needle) return [...rows];
  return rows.filter((r) => r.field || r.label.toLocaleLowerCase().includes(needle));
}

interface Level {
  parent: TrackAction;
  items: TrackAction[];
}

/**
 * The rows of an action menu, with submenus (#2009).
 *
 * Used as the body of every menu that lists `TrackAction`s, so separators,
 * submenus and field rows exist once. It is the `[menuPanel]` element itself:
 * its buttons stay direct children of the panel body, which the phone sheet's
 * 44px rule and the panel's focus and D-pad handling select on.
 *
 * An action with `children` opens a submenu instead of running:
 * - **`drillIn`** (phone sheet, TV): the submenu replaces the list, under a
 *   Back row.
 * - otherwise (desktop popover): a flyout beside the row, on the left when the
 *   right would leave the viewport.
 *
 * `picked` fires for a leaf row only; the menu that owns the list closes
 * itself and runs the action. Hardware Back and Escape close a submenu before
 * the menu; Right opens one and Left returns.
 *
 * Classic `@Input()`s: the web unit harness does not bind signal inputs of a
 * nested component.
 */
/** A quick button is an icon over a short label, so it needs the icon. */
const isQuick = (action: TrackAction): boolean => !!action.quick && !!action.icon;

/** The song, album or artist a menu acts on. */
export interface MenuHeader {
  title: string;
  /** i18n key rendered in place of `title` when set, with its placeholder values. */
  titleKey?: string;
  titleParams?: Record<string, string | number>;
  /** No artwork: the header names a count, not one thing. */
  plain?: boolean;
  subtitle?: string;
  coverSrc?: string | null;
  /** Placeholder art is drawn from these when there is no cover. */
  artist?: string;
  album?: string;
}

@Component({
  selector: 'app-action-list',
  imports: [
    MenuItemComponent,
    TranslatePipe,
    CoverArtComponent,
    OverflowRevealDirective,
    IconComponent,
  ],
  templateUrl: './action-list.component.html',
})
export class ActionListComponent implements OnDestroy {
  /**
   * The menu's rows. A menu rebuilds them whenever something they read changes
   * (a like, a download's progress), so a new list must not throw the user out
   * of the submenu they are in: the open submenu is kept as it is. A menu is
   * created afresh each time it opens, which is what returns it to the top.
   */
  @Input({ required: true }) set actions(value: TrackAction[]) {
    this.root = value;
  }
  /** The menu is a phone bottom sheet: the row that opened it is hidden behind a backdrop. */
  @Input() sheet = false;
  /** What the menu acts on, shown at the top of a sheet (#2007). */
  @Input() header: MenuHeader | null = null;
  @Input() testidPrefix = 'track-action-';
  @Input() tall = false;
  /** A submenu replaces the list (phone sheet, TV) instead of flying out beside it. */
  @Input() drillIn = false;
  /**
   * `menuitem` when the element around the list has `role="menu"` (the entity
   * menu): that role requires it of its children. Menus without ARIA menu
   * roles leave it unset and their rows are plain buttons.
   */
  @Input() itemRole: string | null = null;
  /** A leaf row was chosen. */
  @Output() readonly picked = new EventEmitter<TrackAction>();

  @HostBinding('class.block') readonly block = true;
  @HostBinding('class.relative') readonly relative = true;

  private root: TrackAction[] = [];
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly back = inject(BackButtonService);
  private readonly injector = inject(Injector);
  private unregisterBack: (() => void) | null = null;

  /** Submenus drilled into, outermost first. */
  readonly levels = signal<Level[]>([]);
  /** The open flyout, when not drilling in. */
  readonly flyout = signal<{
    parent: TrackAction;
    items: TrackAction[];
    side: 'right' | 'left';
    top: number;
  } | null>(null);
  readonly filterText = signal('');
  readonly startsGroup = startsGroup;
  readonly noop = (): void => {};

  /** The rows on screen: the top level, or the submenu drilled into. */
  rows(): TrackAction[] {
    const level = this.levels().at(-1);
    if (level) return filterRows(level.items, this.filterText());
    const top = this.sheet ? this.root.filter((a) => !isQuick(a)) : this.root;
    return filterRows(top, this.filterText());
  }

  /** A sheet's first row: the most-used actions as large buttons, taken out of the list. */
  quickRow(): TrackAction[] {
    return this.sheet && !this.parent() ? this.root.filter(isQuick) : [];
  }

  /** The submenu's title, shown on its Back row. */
  parent(): TrackAction | null {
    return this.levels().at(-1)?.parent ?? null;
  }

  async activate(action: TrackAction, row: HTMLElement): Promise<void> {
    if (!action.children) {
      this.picked.emit(action);
      return;
    }
    const items = await action.children();
    if (this.drillIn || this.clipsOverflow()) {
      this.flyout.set(null);
      this.filterText.set('');
      this.levels.update((l) => [...l, { parent: action, items }]);
      this.holdBack();
      queueMicrotask(() => this.focusFirst());
      return;
    }
    if (this.flyout()?.parent.label === action.label) return this.closeFlyout();
    const rect = row.getBoundingClientRect();
    this.flyout.set({
      parent: action,
      items,
      side: flyoutSide(rect, window.innerWidth),
      top: row.offsetTop,
    });
    afterNextRender(() => this.liftFlyout(), { injector: this.injector });
    this.holdBack();
  }

  /** Lift a just-opened flyout clear of the player bar; its height is known only once drawn. */
  private liftFlyout(): void {
    const f = this.flyout();
    const el = this.host.querySelector<HTMLElement>(':scope > [data-testid="menu-flyout"]');
    if (!f || !el) return;
    const shift = flyoutShift(
      el.getBoundingClientRect(),
      window.innerHeight,
      measureBottomChromeInset(this.host),
      measureTopChromeInset(this.host),
    );
    if (shift > 0) this.flyout.set({ ...f, top: f.top - shift });
  }

  /**
   * Enter in a field row. The key is consumed whatever the field does with it:
   * submitting closes the menu, which hands focus back to the menu's trigger
   * button while this same key press is still being delivered, and an
   * unconsumed Enter would then press that button and reopen the menu.
   */
  onFieldEnter(event: Event, action: TrackAction, text: string): void {
    event.preventDefault();
    event.stopPropagation();
    if (action.field?.kind === 'submit') this.submit(action, text);
  }

  /** A field row's text was submitted (Enter). */
  submit(action: TrackAction, text: string): void {
    const value = text.trim();
    const run = action.field?.submit;
    if (!value || !run) return;
    this.picked.emit({ label: action.label, action: () => run(value) });
  }

  /** One level up; false when there was nothing to leave. */
  goBack(): boolean {
    if (this.flyout()) {
      const parent = this.flyout()!.parent;
      this.closeFlyout();
      queueMicrotask(() => this.focusRow(parent));
      return true;
    }
    if (this.levels().length === 0) return false;
    const left = this.levels().at(-1)!.parent;
    this.filterText.set('');
    this.levels.update((l) => l.slice(0, -1));
    if (this.levels().length === 0) this.releaseBack();
    queueMicrotask(() => this.focusRow(left));
    return true;
  }

  private closeFlyout(): void {
    this.flyout.set(null);
    if (this.levels().length === 0) this.releaseBack();
  }

  @HostListener('keydown', ['$event']) onKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT') return;
    if (event.key === 'ArrowRight' && target.dataset['submenu'] === 'true') {
      event.preventDefault();
      event.stopPropagation();
      target.click();
    } else if (event.key === 'ArrowLeft' && this.goBack()) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  /**
   * Whether the menu this list sits in scrolls. A flyout hangs outside the
   * list, so a scrolling menu would clip it: such a menu drills in instead.
   */
  private clipsOverflow(): boolean {
    for (let el = this.host.parentElement; el; el = el.parentElement) {
      const style = getComputedStyle(el);
      if (style.overflowY !== 'visible' || style.overflowX !== 'visible') return true;
      if (style.position === 'fixed') return false;
    }
    return false;
  }

  private holdBack(): void {
    this.unregisterBack ??= this.back.stack.push(() => this.goBack());
  }

  private releaseBack(): void {
    this.unregisterBack?.();
    this.unregisterBack = null;
  }

  private focusFirst(): void {
    this.host
      .querySelector<HTMLElement>(':scope > button:not([data-back]), :scope > div > input')
      ?.focus();
  }

  private focusRow(action: TrackAction): void {
    this.host
      .querySelector<HTMLElement>(
        `:scope > button[data-testid="${this.testidPrefix}${action.label}"]`,
      )
      ?.focus();
  }

  ngOnDestroy(): void {
    this.releaseBack();
  }
}
