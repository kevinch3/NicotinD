import { DestroyRef, Directive, ElementRef, computed, inject } from '@angular/core';
import { TvNavGroupDirective } from './tv-nav-group.directive';

/**
 * Marks a focusable item inside an `appTvNavGroup`. Sets its own roving
 * `tabindex` (0 for the group's active item, -1 for every other item) and
 * tells the group when it's focused directly (click, or Tab from outside),
 * so the roving index stays correct even when arrow keys weren't involved.
 * Works on any focusable element — the actual target of `<button>` (queue
 * rows, transport controls) needs no other change since a button is already
 * natively Enter/Space-activatable.
 */
@Directive({
  selector: '[appTvNavItem]',
  standalone: true,
  host: {
    '[attr.tabindex]': 'tabIndex()',
    '[attr.role]': 'itemRole()',
    '(focusin)': 'onFocusIn()',
  },
})
export class TvNavItemDirective {
  private readonly el = inject(ElementRef<HTMLElement>);
  private readonly group = inject(TvNavGroupDirective, { optional: true });

  /** `role="gridcell"` inside a grid-axis group (issue #359 ARIA
   *  conformance — the group's own `role="grid"` and the templates' new
   *  `role="row"` chunk wrappers need a `gridcell` descendant to be
   *  conformant); `null` (no attribute) for vertical/horizontal groups, which
   *  are plain `toolbar` items with no cell semantics. `axis` is a static
   *  `@Input()` set once by Angular, so this needs no signal dependency to
   *  stay correct. */
  readonly itemRole = computed(() => (this.group?.axis === 'grid' ? 'gridcell' : null));

  constructor() {
    // Register with the group through DI rather than letting the group find
    // us with a content query: DI crosses a component's view boundary, a
    // content query does not (see TvNavGroupDirective's class comment).
    this.group?.registerItem(this);
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(() => this.group?.unregisterItem(this));
  }

  readonly tabIndex = computed(() => {
    if (!this.group) return 0;
    // `isActiveChild` (issue #356): inside a nested group (e.g. a queue row's
    // [jump, remove] pair nested under the rows group), only the row that
    // currently owns focus may hand out tabindex 0 — otherwise every row
    // would independently default its own item to 0, giving a composite
    // widget with N rows N simultaneous Tab stops. Always true for a
    // top-level group (no parent).
    if (!this.group.isActiveChild()) return -1;
    return this.group.indexOf(this) === this.group.activeIndex() ? 0 : -1;
  });

  onFocusIn(): void {
    this.group?.notifyFocused(this);
  }

  focusElement(): void {
    this.el.nativeElement.focus();
  }

  /** The item's own element — used by the group's grid-axis handler to read
   *  `offsetTop` for row inference (see `inferColumnsPerRow`). */
  get nativeElement(): HTMLElement {
    return this.el.nativeElement;
  }

  /** Whether `target` is this item's element or a descendant of it — used by
   *  the group's `onKeydown` to ignore arrow-key events that bubbled up from
   *  a focusable descendant that isn't itself an `appTvNavItem`. */
  containsEventTarget(target: EventTarget | null): boolean {
    return target instanceof Node && this.el.nativeElement.contains(target);
  }
}
