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

export type TvNavAxis = 'vertical' | 'horizontal';

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
}
