import { Directive, Input, effect, signal } from '@angular/core';
import { TvNavItemDirective } from './tv-nav-item.directive';
import { inferColumnsPerRow } from '../lib/tv-nav-grid';

export type TvNavAxis = 'vertical' | 'horizontal' | 'grid';

/** Comparator ordering two items by their elements' real document position. */
function byDomOrder(a: TvNavItemDirective, b: TvNavItemDirective): number {
  const position = a.nativeElement.compareDocumentPosition(b.nativeElement);
  if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
  if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
  return 0;
}

/**
 * Roving-tabindex D-pad/arrow-key navigation for a list/row of `appTvNavItem`
 * elements — one WAI-ARIA-pattern group per container (queue rows, a
 * transport-button row, a library grid row/column later). No wrap: an arrow
 * key at a group's edge is a no-op (not preventDefault'd) rather than
 * jumping to the opposite end, so a future outer/global handler can still
 * react to it if needed.
 *
 * Items are NOT discovered with `@ContentChildren`: an Angular content query
 * stops at a component's view boundary, so an `appTvNavItem` marked inside a
 * child component's own template (e.g. the title button in
 * `TrackRowComponent`) is invisible to an ancestor group — and worse than a
 * no-op, since `TvNavItemDirective`'s `inject(TvNavGroupDirective)` DOES
 * cross that boundary, so such an item found the group, never appeared in
 * `items()`, and pinned itself to `tabindex="-1"` (dropping out of the Tab
 * order entirely). Items therefore register themselves with the group
 * through DI instead — the one lookup that provably crosses the boundary.
 *
 * Implementation note (deviates from the original spec's signal-API sketch):
 * `axis` is a classic `@Input()` rather than the newer `input()` signal
 * function, which does not populate in this project's hand-rolled vitest+JIT TestBed
 * harness (no `@angular/build:unit-test`, no zone.js — see docs/web-ui.md
 * "Web test harness"): verified down to a minimal `viewChild()`/`input()`
 * sanity check on a bare component with no directives involved, so it isn't
 * specific to this directive pair. JIT compilation here just never
 * discovers `input()`-declared class fields as bindable properties (a
 * limitation of this project's JIT-based vitest test harness, not a general
 * Angular constraint), so every value stays at its default. The classic
 * decorator API binds the same way and works correctly under the same
 * harness, so it's what's used here.
 */
@Directive({
  selector: '[appTvNavGroup]',
  standalone: true,
  host: {
    '(keydown)': 'onKeydown($event)',
    // `role="grid"` is the correct ARIA role for a 2-D grid of focusable
    // items; `aria-orientation` only accepts "horizontal"/"vertical", so it
    // is omitted (null) on the grid axis rather than emitting an invalid
    // `aria-orientation="grid"`.
    '[attr.role]': "axis === 'grid' ? 'grid' : 'toolbar'",
    '[attr.aria-orientation]': "axis === 'grid' ? null : axis",
  },
})
export class TvNavGroupDirective {
  @Input() axis: TvNavAxis = 'vertical';

  private readonly itemsSignal = signal<readonly TvNavItemDirective[]>([]);

  /** Registration-order array the last memoized sort was derived from, and
   *  that sort. Not a `computed()` — see `items` for why memoizing
   *  unconditionally would be wrong. */
  private sortedFrom: readonly TvNavItemDirective[] | null = null;
  private sorted: readonly TvNavItemDirective[] = [];

  /** The group's items in real DOM order.
   *
   *  Reads the registration-order signal (so it stays a reactive dependency
   *  for the `tabIndex`/`effect` consumers) and sorts by document position on
   *  read rather than at registration: an item registers from its own
   *  constructor, where its host element is NOT yet attached to the document
   *  (`isConnected === false` for anything inside an `@for`/embedded view or
   *  a nested component's template), and `compareDocumentPosition` on
   *  detached nodes returns an arbitrary order — sorting there reversed every
   *  group in practice.
   *
   *  The sort is memoized per registration-order array, but ONLY once every
   *  element is actually in the document; until then the computed order is
   *  meaningless and must not be cached. That guard is what makes a
   *  `computed()` unusable here: it would memoize the first (detached, wrong)
   *  evaluation and hold it until the next registration. */
  readonly items = (): readonly TvNavItemDirective[] => {
    const raw = this.itemsSignal();
    if (this.sortedFrom === raw) return this.sorted;
    const next = [...raw].sort(byDomOrder);
    if (next.every((item) => item.nativeElement.isConnected)) {
      this.sortedFrom = raw;
      this.sorted = next;
    }
    return next;
  };

  readonly activeIndex = signal(0);

  constructor() {
    // Keep the roving index in range if items are added/removed (e.g. the
    // queue shrinks after a track is removed).
    effect(() => {
      const len = this.items().length;
      if (len > 0 && this.activeIndex() > len - 1) {
        this.activeIndex.set(len - 1);
      }
    });
  }

  /** Called by a `TvNavItemDirective` from its own constructor. Registration
   *  order is not meaningful (see `items`) — `items()` re-derives DOM order
   *  on read. */
  registerItem(item: TvNavItemDirective): void {
    this.itemsSignal.update((items) => [...items, item]);
  }

  unregisterItem(item: TvNavItemDirective): void {
    this.itemsSignal.update((items) => items.filter((i) => i !== item));
  }

  /** Called by a `TvNavItemDirective` on `focusin` so a direct click/Tab into
   *  a non-active item keeps the roving tabindex in sync with real focus. */
  notifyFocused(item: TvNavItemDirective): void {
    const idx = this.items().indexOf(item);
    if (idx >= 0) this.activeIndex.set(idx);
  }

  onKeydown(event: KeyboardEvent): void {
    const items = this.items();
    if (items.length === 0) return;
    // The (keydown) host listener fires for any descendant's keydown,
    // including focusable elements deliberately not marked appTvNavItem
    // (e.g. a queue-remove button). Those never update activeIndex via
    // TvNavItemDirective's focusin handler, so acting on the event here
    // would move focus based on a stale activeIndex rather than where the
    // user's focus actually is. Bail unless the event actually originated
    // inside one of this group's own items.
    if (!items.some((item) => item.containsEventTarget(event.target))) return;
    if (this.axis === 'grid') {
      this.onGridKeydown(event, items);
      return;
    }
    const forwardKey = this.axis === 'vertical' ? 'ArrowDown' : 'ArrowRight';
    const backwardKey = this.axis === 'vertical' ? 'ArrowUp' : 'ArrowLeft';
    let next: number | null = null;
    if (event.key === forwardKey) next = Math.min(this.activeIndex() + 1, items.length - 1);
    else if (event.key === backwardKey) next = Math.max(this.activeIndex() - 1, 0);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    if (next === null || next === this.activeIndex()) return;
    event.preventDefault();
    this.activeIndex.set(next);
    items[next]!.focusElement();
  }

  /** Grid axis: ArrowLeft/Right move within the current row (clamped at its
   *  edges, no wrap into the adjacent row); ArrowUp/Down jump a full row,
   *  landing on the same column (clamped into a shorter row). Row width is
   *  inferred from layout via `inferColumnsPerRow` rather than a configured
   *  column count, so it tracks any responsive `grid-cols-*` breakpoint.
   *  `idx` is derived from the item the keydown actually originated on
   *  (`onKeydown`'s bail check above already guarantees a match), not the
   *  `activeIndex` signal — the two are normally in sync (roving tabindex +
   *  `focusin` keep them so), but deriving from the event's own target is
   *  the more correct source of "where the user's focus currently is" for a
   *  handler that runs synchronously inside the same event. */
  private onGridKeydown(event: KeyboardEvent, items: readonly TvNavItemDirective[]): void {
    const cols = inferColumnsPerRow(items.map((item) => item.nativeElement));
    const originIndex = items.findIndex((item) => item.containsEventTarget(event.target));
    const idx = originIndex >= 0 ? originIndex : this.activeIndex();
    const rowStart = Math.floor(idx / cols) * cols;
    const rowEnd = Math.min(rowStart + cols - 1, items.length - 1);
    const colInRow = idx - rowStart;
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = Math.min(idx + 1, rowEnd);
    else if (event.key === 'ArrowLeft') next = Math.max(idx - 1, rowStart);
    else if (event.key === 'ArrowDown') {
      const targetRowStart = rowStart + cols;
      if (targetRowStart < items.length) {
        next = Math.min(targetRowStart + colInRow, items.length - 1);
      }
    } else if (event.key === 'ArrowUp') {
      if (rowStart > 0) next = rowStart - cols + colInRow;
    } else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    // `next === null` means the key wasn't a grid nav key, or Up/Down hit the
    // first/last row (nothing to jump to) — a true no-op, don't touch focus.
    // A clamped Left/Right/Home/End resolves `next` to `idx` itself (already
    // at the row/grid edge): still re-sync real DOM focus onto that resolved
    // item (idempotent when it's already focused) so focus never drifts from
    // the roving-tabindex-active item, but skip `preventDefault` since no
    // actual navigation occurred.
    if (next === null) return;
    if (next !== idx) event.preventDefault();
    this.activeIndex.set(next);
    items[next]!.focusElement();
  }
}
