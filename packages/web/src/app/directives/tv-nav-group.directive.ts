import {
  AfterContentInit,
  ContentChildren,
  Directive,
  DestroyRef,
  Input,
  QueryList,
  effect,
  inject,
  signal,
} from '@angular/core';
import { TvNavItemDirective } from './tv-nav-item.directive';
import { inferColumnsPerRow } from '../lib/tv-nav-grid';

export type TvNavAxis = 'vertical' | 'horizontal' | 'grid';

/**
 * Roving-tabindex D-pad/arrow-key navigation for a list/row of `appTvNavItem`
 * elements — one WAI-ARIA-pattern group per container (queue rows, a
 * transport-button row, a library grid row/column later). No wrap: an arrow
 * key at a group's edge is a no-op (not preventDefault'd) rather than
 * jumping to the opposite end, so a future outer/global handler can still
 * react to it if needed.
 *
 * Implementation note (both deviate from the original spec's signal-API
 * sketch): `axis` is a classic `@Input()`, and `items` is read via
 * `@ContentChildren`/`QueryList` bridged into a `signal`, rather than the
 * newer `input()`/`contentChildren()` signal functions. Neither signal
 * function populates in this project's hand-rolled vitest+JIT TestBed
 * harness (no `@angular/build:unit-test`, no zone.js — see docs/web-ui.md
 * "Web test harness"): verified down to a minimal `viewChild()`/`input()`
 * sanity check on a bare component with no directives involved, so it isn't
 * specific to this directive pair. JIT compilation here just never
 * discovers `input()`-declared class fields as bindable properties (a
 * limitation of this project's JIT-based vitest test harness, not a general
 * Angular constraint), so every value stays at its default. The classic
 * decorator APIs query/bind the same descendants and work correctly under
 * the same harness, so they're what's used here.
 */
@Directive({
  selector: '[appTvNavGroup]',
  standalone: true,
  host: {
    '(keydown)': 'onKeydown($event)',
    role: 'toolbar',
    '[attr.aria-orientation]': 'axis',
  },
})
export class TvNavGroupDirective implements AfterContentInit {
  @Input() axis: TvNavAxis = 'vertical';

  @ContentChildren(TvNavItemDirective, { descendants: true })
  private readonly itemsQuery!: QueryList<TvNavItemDirective>;

  private readonly itemsSignal = signal<readonly TvNavItemDirective[]>([]);
  readonly items = this.itemsSignal.asReadonly();
  readonly activeIndex = signal(0);

  private readonly destroyRef = inject(DestroyRef);

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

  ngAfterContentInit(): void {
    this.itemsSignal.set(this.itemsQuery.toArray());
    const sub = this.itemsQuery.changes.subscribe((ql: QueryList<TvNavItemDirective>) => {
      this.itemsSignal.set(ql.toArray());
    });
    this.destroyRef.onDestroy(() => sub.unsubscribe());
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
