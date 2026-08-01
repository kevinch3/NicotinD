import { DestroyRef, Directive, ElementRef, Input, inject, signal } from '@angular/core';
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

/** Whether `items` is still sorted by document position — an O(n) adjacent-pair
 *  scan (n-1 `compareDocumentPosition` calls, no allocation) used to validate a
 *  memoized sort. Sortedness is transitive under document order, so checking
 *  consecutive pairs is sufficient: any single element that moved breaks at
 *  least one adjacency. */
function isInDomOrder(items: readonly TvNavItemDirective[]): boolean {
  for (let i = 1; i < items.length; i++) {
    if (byDomOrder(items[i - 1]!, items[i]!) > 0) return false;
  }
  return true;
}

/**
 * Roving-tabindex D-pad/arrow-key navigation for a list/row of `appTvNavItem`
 * elements — one WAI-ARIA-pattern group per container (queue rows, a
 * transport-button row, a library grid row/column later). No wrap: an arrow
 * key at a group's edge does not move focus rather than jumping to the
 * opposite end — but it IS `preventDefault`'d, because the group recognized
 * the key and owns the press. That makes an edge press a true no-op for D-pad
 * users instead of leaking through to the global ArrowLeft/Right seek
 * shortcut (`KeyboardShortcutsService`), which would otherwise jump the
 * playing track ±10s every time focus hit a group boundary. A key this axis
 * does NOT navigate by (e.g. ArrowUp inside a 'horizontal' group) is left
 * un-prevented and keeps bubbling.
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
   *  The sort is memoized, on two conditions that are both load-bearing:
   *
   *  1. The memo is only *stored* once every element is actually in the
   *     document; until then the computed order is meaningless. This is what
   *     makes a `computed()` unusable here — it would memoize the first
   *     (detached, wrong) evaluation and hold it until the next registration.
   *  2. The memo is only *reused* while the cached array is still in document
   *     order (`isInDomOrder`, an O(n) adjacent-pair scan). Keying the memo on
   *     the registration array's identity alone is NOT enough: a **pure
   *     reorder** — the same item set re-rendered in a new order, e.g. an
   *     `@for` tracked by a stable id when `ListControlsService.filtered()`
   *     re-sorts a Library grid from the sort dropdown — moves the views
   *     without any destroy/create, so no register/unregister fires and the
   *     identity never changes. Without the check, `items()` returned the
   *     stale order forever and the roving `tabindex="0"` landed on the wrong
   *     card. The check costs n-1 `compareDocumentPosition` calls with no
   *     allocation, versus a full re-sort's n·log n plus a copy, so the
   *     common (nothing moved) case stays cheap. */
  readonly items = (): readonly TvNavItemDirective[] => {
    // Read so a DOM-only reorder still invalidates the item `tabIndex`
    // computeds — see `domVersion`.
    this.domVersion();
    const raw = this.itemsSignal();
    if (this.sortedFrom === raw && isInDomOrder(this.sorted)) return this.sorted;
    const next = [...raw].sort(byDomOrder);
    if (next.every((item) => item.nativeElement.isConnected)) {
      this.sortedFrom = raw;
      this.sorted = next;
    }
    return next;
  };

  /** Bumped when the group's child list changes. A pure reorder writes to no
   *  signal this directive owns, so without it the item `tabIndex` computeds
   *  never re-evaluate and the rendered roving `tabindex="0"` stays on the
   *  card that used to be first — `items()` returning the right answer is not
   *  enough when nothing asks it again. */
  private readonly domVersion = signal(0);

  readonly activeIndex = signal(0);

  constructor() {
    this.watchDomOrder();
  }

  /** Keep the roving index in range after `itemsSignal` changes size (items
   *  added/removed — e.g. the queue shrinks after a track is removed).
   *  Called directly from `registerItem`/`unregisterItem` rather than a
   *  reactive `effect()`: `itemsSignal` only ever changes via those two
   *  methods, so a self-writing effect that re-triggers on every change is
   *  strictly equivalent to — and less direct than — clamping at the two
   *  call sites that can put it out of range. */
  private clampActiveIndex(): void {
    const len = this.itemsSignal().length;
    if (len > 0 && this.activeIndex() > len - 1) {
      this.activeIndex.set(len - 1);
    }
  }

  /** Angular moves views on a pure reorder without touching any signal this
   *  directive owns, so the only reliable notification is the DOM itself.
   *
   *  `childList` **without `subtree`**: a reorder relocates the group's own
   *  direct children (every current consumer repeats a direct child — an `<a>`
   *  card, an `<li>`, a `<button>`, an `<app-track-row>`), so this catches all
   *  of them while ignoring the far noisier churn deeper inside a row (a menu
   *  opening, a cover-art placeholder swapping for an `<img>`). A future
   *  consumer that repeats something nested deeper degrades gracefully rather
   *  than breaking: `items()` still self-heals on read, so navigation stays
   *  correct and only the rendered `tabindex` could lag.
   *
   *  The bump is unconditional rather than guarded on the cached order still
   *  being stale, because `items()` self-heals and would silently repair the
   *  cache before this callback runs, hiding the very change it must report. A
   *  redundant bump is cheap and, without `subtree`, rare: this fires only when
   *  items are actually added, removed or moved, and an unchanged `tabIndex`
   *  result writes nothing to the DOM. */
  private watchDomOrder(): void {
    if (typeof MutationObserver === 'undefined') return;
    const host = inject(ElementRef<HTMLElement>).nativeElement;
    const observer = new MutationObserver(() => this.domVersion.update((v) => v + 1));
    observer.observe(host, { childList: true });
    inject(DestroyRef).onDestroy(() => observer.disconnect());
  }

  /** Called by a `TvNavItemDirective` from its own constructor. Registration
   *  order is not meaningful (see `items`) — `items()` re-derives DOM order
   *  on read. */
  registerItem(item: TvNavItemDirective): void {
    this.itemsSignal.update((items) => [...items, item]);
    this.clampActiveIndex();
  }

  unregisterItem(item: TvNavItemDirective): void {
    this.itemsSignal.update((items) => items.filter((i) => i !== item));
    this.clampActiveIndex();
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
    // `next === null` means the key isn't one this axis navigates by (e.g.
    // ArrowUp inside a 'horizontal' group): the group has no opinion, so the
    // event keeps bubbling un-prevented for whoever else wants it.
    if (next === null) return;
    // The group DID recognize this key, so it owns the press even when the
    // result is clamped to where focus already is (an edge). preventDefault is
    // therefore unconditional here: an edge press must be a true no-op for
    // D-pad users, not something the global ArrowLeft/Right seek shortcut
    // picks up and turns into a ±10s jump. Only the focus move stays gated —
    // re-focusing the already-focused item would be pointless churn.
    event.preventDefault();
    if (next === this.activeIndex()) return;
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
    // first/last row (nothing to jump to) — a true no-op; leave the event
    // un-prevented so it keeps bubbling for whoever else wants it.
    if (next === null) return;
    // Otherwise the grid recognized and resolved the key, so it owns the press
    // even when clamped to `idx` itself (already at a row/grid edge): an edge
    // press must be a true no-op for D-pad users rather than something the
    // global ArrowLeft/Right seek shortcut then turns into a ±10s jump. Focus
    // is still re-synced onto the resolved item (idempotent when already
    // focused) so it never drifts from the roving-tabindex-active item.
    event.preventDefault();
    this.activeIndex.set(next);
    items[next]!.focusElement();
  }
}
