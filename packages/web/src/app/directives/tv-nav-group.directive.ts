import { DestroyRef, Directive, ElementRef, Input, computed, inject, signal } from '@angular/core';
import { TvNavItemDirective } from './tv-nav-item.directive';
import { gridColumnCount, inferColumnsPerRow } from '../lib/tv-nav-grid';

export type TvNavAxis = 'vertical' | 'horizontal' | 'grid';

/** Anything with a real DOM element to order by — both `TvNavItemDirective`
 *  (leaf items) and `TvNavGroupDirective` itself (nested child groups, issue
 *  #356) satisfy this. */
interface DomPositioned {
  readonly nativeElement: HTMLElement;
}

/** Comparator ordering two entries by their elements' real document position. */
function byDomOrder<T extends DomPositioned>(a: T, b: T): number {
  const position = a.nativeElement.compareDocumentPosition(b.nativeElement);
  if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
  if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
  return 0;
}

/** Whether `entries` is still sorted by document position — an O(n)
 *  adjacent-pair scan (n-1 `compareDocumentPosition` calls, no allocation)
 *  used to validate a memoized sort. Sortedness is transitive under document
 *  order, so checking consecutive pairs is sufficient: any single element
 *  that moved breaks at least one adjacency. */
function isInDomOrder<T extends DomPositioned>(entries: readonly T[]): boolean {
  for (let i = 1; i < entries.length; i++) {
    if (byDomOrder(entries[i - 1]!, entries[i]!) > 0) return false;
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
  // `#var="appTvNavGroup"` lets a template read `gridColumns()` to chunk its
  // flat item array into `role="row"` slices (issue #359).
  exportAs: 'appTvNavGroup',
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

  private readonly hostElementRef = inject(ElementRef<HTMLElement>);

  /** This group's own element — lets an ANCESTOR group treat this whole group
   *  as one nestable entry (issue #356's child-group navigation), the same
   *  way a `TvNavItemDirective` exposes its element to its own group. */
  get nativeElement(): HTMLElement {
    return this.hostElementRef.nativeElement;
  }

  /** Whether `target` is this group's element or a descendant of it — the
   *  group-level counterpart to `TvNavItemDirective.containsEventTarget`,
   *  used by an ancestor group's `onKeydown` to find which child group a
   *  bubbled keydown originated in (issue #356). */
  containsEventTarget(target: EventTarget | null): boolean {
    return target instanceof Node && this.nativeElement.contains(target);
  }

  /** The nearest ANCESTOR group, if any (issue #356's nested two-axis model —
   *  e.g. a queue row's `axis="horizontal"` group of [jump, remove] nested
   *  inside the queue's `axis="vertical"` rows group). `skipSelf` documents
   *  intent (find an ancestor, not this instance) even though, in practice,
   *  each group directive is already on its own distinct element so default
   *  resolution would never self-match. */
  private readonly parentGroup = inject(TvNavGroupDirective, { optional: true, skipSelf: true });

  private readonly itemsSignal = signal<readonly TvNavItemDirective[]>([]);

  /** Registration-order array the last memoized sort was derived from, and
   *  that sort — plus an item→index map over the same memoized array so a
   *  lookup (an item's own `tabIndex` computed, evaluated once per item per
   *  keypress) is O(1) instead of `indexOf`'s O(n) (issue #357, the safe half
   *  — see `indexOf`). Not a `computed()` — see `items` for why memoizing
   *  unconditionally would be wrong. */
  private sortedFrom: readonly TvNavItemDirective[] | null = null;
  private sorted: readonly TvNavItemDirective[] = [];
  private sortedIndex = new Map<TvNavItemDirective, number>();

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
   *     common (nothing moved) case stays cheap.
   *
   *  **Issue #357 investigated wrapping this in a real `computed()`** so its
   *  n-per-keypress re-invocations (once per item's own `tabIndex` computed)
   *  would collapse to one. That breaks correctness: `computed()` only
   *  re-runs when a tracked signal's *value* changes, but a pure reorder
   *  changes neither `itemsSignal` nor `domVersion` synchronously — the
   *  `MutationObserver` bump is async — so a `computed()` here would keep
   *  serving the pre-reorder answer until a later microtask, violating the
   *  "reflected on the very next read" guarantee
   *  `tv-nav-group.directive.spec.ts`'s pure-reorder test asserts (confirmed
   *  by actually trying it — the test failed exactly this way). The
   *  `isInDomOrder` scan therefore has to run on every read; only the
   *  `indexOf` half of #357 is safely fixable (see `indexOf`). */
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
      this.sortedIndex = new Map(next.map((item, i) => [item, i]));
    }
    return next;
  };

  /** O(1) counterpart to `items().indexOf(item)` (issue #357) — the memoized
   *  sort's index map is rebuilt in lockstep with `this.sorted`, so a lookup
   *  against the currently-memoized array is a `Map.get`. Falls back to
   *  `indexOf` only in the rare not-yet-fully-connected transient case where
   *  `items()` returns an unmemoized array (no `sortedIndex` for it) — O(n),
   *  but that path is registration-time only, not the per-keypress hot path
   *  this issue is about. */
  indexOf(item: TvNavItemDirective): number {
    const items = this.items();
    return items === this.sorted ? (this.sortedIndex.get(item) ?? -1) : items.indexOf(item);
  }

  // ─── Nested child groups (issue #356) ────────────────────────────────
  //
  // A composite row — e.g. a queue row's [jump, remove] pair — nests an
  // `axis="horizontal"` group inside the queue's `axis="vertical"` rows
  // group, so Remove becomes D-pad reachable (ArrowRight from the jump
  // button) without flattening [jump, remove, jump, remove, ...] into one
  // sequence, which would break "ArrowDown moves to the next row". A child
  // group registers itself with its nearest ancestor (`parentGroup` above)
  // exactly like a `TvNavItemDirective` registers with its nearest group —
  // same DOM-order memoization (`childGroupsSorted`/`isInDomOrder`) as
  // `items`, since rows are drag-to-reorderable.

  private readonly childGroupsSignal = signal<readonly TvNavGroupDirective[]>([]);
  private childGroupsSortedFrom: readonly TvNavGroupDirective[] | null = null;
  private childGroupsSorted: readonly TvNavGroupDirective[] = [];

  /** The group's nested child groups in real DOM order — empty for a group
   *  with no nested groups (every existing flat consumer), in which case
   *  `onKeydown` falls back to its original items-only behavior untouched. */
  readonly childGroups = (): readonly TvNavGroupDirective[] => {
    this.domVersion();
    const raw = this.childGroupsSignal();
    if (this.childGroupsSortedFrom === raw && isInDomOrder(this.childGroupsSorted)) {
      return this.childGroupsSorted;
    }
    const next = [...raw].sort(byDomOrder);
    if (next.every((group) => group.nativeElement.isConnected)) {
      this.childGroupsSortedFrom = raw;
      this.childGroupsSorted = next;
    }
    return next;
  };

  /** Which child group currently owns focus — the group-level counterpart to
   *  `activeIndex`, kept in sync purely by the `notifyFocused` → parent chain
   *  below (real focus moving into any descendant item), never written
   *  directly by keydown handling (see `onKeydownOverChildGroups`). */
  private readonly activeChildIndex = signal(0);

  /** Whether this group is its parent's currently-focused child (always true
   *  for a top-level group with no parent). A nested group's items must NOT
   *  hand out `tabindex="0"` unless this is true — otherwise every row would
   *  independently default its own jump button to tabindex 0, giving a
   *  composite widget with N rows N simultaneous Tab stops instead of the
   *  one a roving-tabindex pattern requires. Read by `TvNavItemDirective`. */
  readonly isActiveChild = computed((): boolean => {
    const parent = this.parentGroup;
    if (!parent) return true;
    return parent.childGroups().indexOf(this) === parent.activeChildIndex();
  });

  /** Called by a nested `TvNavGroupDirective` from its own constructor. */
  registerChildGroup(group: TvNavGroupDirective): void {
    this.childGroupsSignal.update((groups) => [...groups, group]);
    this.clampActiveChildIndex();
  }

  unregisterChildGroup(group: TvNavGroupDirective): void {
    this.childGroupsSignal.update((groups) => groups.filter((g) => g !== group));
    this.clampActiveChildIndex();
  }

  private clampActiveChildIndex(): void {
    const len = this.childGroupsSignal().length;
    if (len > 0 && this.activeChildIndex() > len - 1) {
      this.activeChildIndex.set(len - 1);
    }
  }

  /** Called by a child group whenever ITS OWN `notifyFocused` fires (i.e. real
   *  focus landed on one of that child's own items) — propagates "which row
   *  is active" up one level, exactly mirroring how `notifyFocused` keeps
   *  `activeIndex` in sync for plain items. */
  private notifyActiveChildGroup(group: TvNavGroupDirective): void {
    const idx = this.childGroups().indexOf(group);
    if (idx >= 0) this.activeChildIndex.set(idx);
  }

  /** Focuses this group's own currently-active item — how an ancestor group
   *  moves real focus "down" into a resolved child group after ArrowUp/Down
   *  (issue #356's `onKeydownOverChildGroups`). */
  focusActiveItem(): void {
    const items = this.items();
    items[this.activeIndex()]?.focusElement();
  }

  /** Bumped when the group's child list changes. A pure reorder writes to no
   *  signal this directive owns, so without it the item `tabIndex` computeds
   *  never re-evaluate and the rendered roving `tabindex="0"` stays on the
   *  card that used to be first — `items()` returning the right answer is not
   *  enough when nothing asks it again. */
  private readonly domVersion = signal(0);

  readonly activeIndex = signal(0);

  /** Column count for `axis="grid"` consumers, read from the container's own
   *  resolved `grid-template-columns` (issue #359) — templates use this to
   *  `chunk()` their flat item array into `role="row"` slices, so Angular
   *  itself owns the row-wrapper structure from the start (a directive
   *  reparenting already-rendered items into synthetic wrappers was tried and
   *  is unsafe: it silently breaks Angular's own add/remove reconciliation
   *  for the underlying `@for`, verified with a real TestBed reproduction).
   *  Re-measured on resize/breakpoint change via `ResizeObserver` so a
   *  responsive `grid-cols-*` class stays accurate; defaults to 1 (one item
   *  per row) until the container has actually laid out. */
  readonly gridColumns = signal(1);

  constructor() {
    this.watchDomOrder();
    this.watchGridColumns();
    this.parentGroup?.registerChildGroup(this);
    inject(DestroyRef).onDestroy(() => this.parentGroup?.unregisterChildGroup(this));
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

  /** Measures `gridColumns` on init and on any resize/layout change. Guarded
   *  on `ResizeObserver` existing (this project's vitest+jsdom test harness
   *  has no global `ResizeObserver`, matching `watchDomOrder`'s
   *  `MutationObserver` guard above) — a group that never re-measures still
   *  gets its one initial, synchronous reading. */
  private watchGridColumns(): void {
    const host = inject(ElementRef<HTMLElement>).nativeElement;
    const update = () => this.gridColumns.set(gridColumnCount(host));
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(host);
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
   *  a non-active item keeps the roving tabindex in sync with real focus.
   *  Also tells this group's OWN parent (if any) that this group is now the
   *  active child (issue #356) — the same real-focus signal doubles as both
   *  levels' sync mechanism, so a click/Tab landing anywhere in a nested
   *  composite keeps the whole tree's roving tabindex correct. */
  notifyFocused(item: TvNavItemDirective): void {
    const idx = this.indexOf(item);
    if (idx >= 0) this.activeIndex.set(idx);
    this.parentGroup?.notifyActiveChildGroup(this);
  }

  /** Resolves "where the user's focus actually is" for a keydown, from the
   *  event's own origin item rather than the `activeIndex` signal (issue
   *  #358) — the two axes used to disagree on this (grid derived from the
   *  event target, vertical/horizontal read `activeIndex()` directly), which
   *  meant a pure reorder that left real DOM focus on an element now at a
   *  different ordinal position could act from the wrong origin on the
   *  vertical/horizontal axis for one keypress before `focusin` resynced it.
   *  Deriving from the event target is strictly more correct — it's where
   *  focus provably is *right now*, in the same synchronous handler — and
   *  the two callers writing `this.activeIndex.set(next)` from the result
   *  keeps the signal self-correcting even if it had drifted. Falls back to
   *  `activeIndex()` only if no item claims the target, which `onKeydown`'s
   *  bail-out above already guarantees won't happen for its callers. */
  private originIndex(
    event: KeyboardEvent,
    entries: readonly { containsEventTarget(target: EventTarget | null): boolean }[],
    fallback: number,
  ): number {
    const idx = entries.findIndex((entry) => entry.containsEventTarget(event.target));
    return idx >= 0 ? idx : fallback;
  }

  onKeydown(event: KeyboardEvent): void {
    const childGroups = this.childGroups();
    if (childGroups.length > 0) {
      this.onKeydownOverChildGroups(event, childGroups);
      return;
    }
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
    const current = this.originIndex(event, items, this.activeIndex());
    let next: number | null = null;
    if (event.key === forwardKey) next = Math.min(current + 1, items.length - 1);
    else if (event.key === backwardKey) next = Math.max(current - 1, 0);
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
    if (next === current) return;
    this.activeIndex.set(next);
    items[next]!.focusElement();
  }

  /** Grid axis: ArrowLeft/Right move within the current row (clamped at its
   *  edges, no wrap into the adjacent row); ArrowUp/Down jump a full row,
   *  landing on the same column (clamped into a shorter row). Row width is
   *  inferred from layout via `inferColumnsPerRow` rather than a configured
   *  column count, so it tracks any responsive `grid-cols-*` breakpoint.
   *  `idx` is derived via the shared `originIndex` helper (issue #358 unified
   *  this with the vertical/horizontal axis, which used to read `activeIndex`
   *  directly instead) — the two are normally in sync (roving tabindex +
   *  `focusin` keep them so), but deriving from the event's own target is
   *  the more correct source of "where the user's focus currently is" for a
   *  handler that runs synchronously inside the same event. */
  private onGridKeydown(event: KeyboardEvent, items: readonly TvNavItemDirective[]): void {
    const cols = inferColumnsPerRow(items.map((item) => item.nativeElement));
    const idx = this.originIndex(event, items, this.activeIndex());
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

  /** Navigates between nested child groups rather than plain items (issue
   *  #356) — used when `this.axis` describes how ROWS relate to each other
   *  (e.g. `vertical` rows of `horizontal` [jump, remove] pairs), not how the
   *  leaf items within one row relate. Only Home/End plus the axis's own
   *  forward/backward keys are meaningful at this level; a nested group's own
   *  `onKeydown` already handles movement WITHIN a row (e.g. ArrowRight from
   *  jump to remove) and simply doesn't recognize ArrowDown/Up, letting them
   *  bubble here un-prevented — the same "axis has no opinion" mechanism
   *  `onKeydown` already relies on for the plain-items case. `grid`-axis
   *  child-group nesting isn't a current need, so only vertical/horizontal
   *  are handled. */
  private onKeydownOverChildGroups(
    event: KeyboardEvent,
    groups: readonly TvNavGroupDirective[],
  ): void {
    if (!groups.some((group) => group.containsEventTarget(event.target))) return;
    if (this.axis === 'grid') return;
    const forwardKey = this.axis === 'vertical' ? 'ArrowDown' : 'ArrowRight';
    const backwardKey = this.axis === 'vertical' ? 'ArrowUp' : 'ArrowLeft';
    const current = this.originIndex(event, groups, this.activeChildIndex());
    let next: number | null = null;
    if (event.key === forwardKey) next = Math.min(current + 1, groups.length - 1);
    else if (event.key === backwardKey) next = Math.max(current - 1, 0);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = groups.length - 1;
    if (next === null) return;
    event.preventDefault();
    if (next === current) return;
    // `focusActiveItem` moving real focus synchronously triggers the target
    // group's own `focusin` → `notifyFocused` → `notifyActiveChildGroup`
    // chain, which is what actually updates `activeChildIndex` — mirroring
    // how the plain-items path leaves `notifyFocused` as the source of truth
    // rather than writing the signal from two places.
    groups[next]!.focusActiveItem();
  }
}
