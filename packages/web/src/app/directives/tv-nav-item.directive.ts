import { DestroyRef, Directive, ElementRef, computed, inject } from '@angular/core';
import { TvNavGroupDirective } from './tv-nav-group.directive';

/**
 * Marks a focusable item inside an `appTvNavGroup`. Sets its own roving
 * `tabindex` (0 for the group's active item, -1 for every other item) and
 * tells the group when it's focused directly (click, or Tab from outside),
 * so the roving index stays correct even when arrow keys weren't involved.
 * Works on any focusable element — the actual target of `<button>` (queue
 * rows, transport controls) needs no other change since a button is already
 * natively Enter/Space-activatable. Hosts that are NOT natively activatable
 * (e.g. the Admin duplicates `<label>` rows, issue #396) get an Enter/Space →
 * `click()` passthrough so a D-pad select activates them like any button.
 */
@Directive({
  selector: '[appTvNavItem]',
  standalone: true,
  host: {
    '[attr.tabindex]': 'tabIndex()',
    '[attr.role]': 'itemRole()',
    '(focusin)': 'onFocusIn()',
    '(keydown.enter)': 'onActivateKey($event)',
    '(keydown.space)': 'onActivateKey($event)',
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
  /** A role the template already set on the host, captured before the host
   *  binding below can overwrite it. Without this, `[attr.role]` clobbers an
   *  author-provided `role="button"` with `null` on every non-grid item — the
   *  player's grab notch is a focusable `<div>` that must still announce
   *  itself as a button (issue #432). */
  private readonly authoredRole = this.el.nativeElement.getAttribute('role');

  readonly itemRole = computed(() =>
    this.group?.axis === 'grid' ? 'gridcell' : this.authoredRole,
  );

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
    // `directItemsActive` folds two conditions (issues #356/#389): the group
    // must be its parent's active child, AND — in a mixed items+child-groups
    // container — the active entry kind must be an item, so a direct item and
    // a nested group's item can never both claim the single Tab stop.
    if (!this.group.directItemsActive()) return -1;
    return this.group.indexOf(this) === this.group.activeIndex() ? 0 : -1;
  });

  onFocusIn(): void {
    this.group?.notifyFocused(this);
  }

  /** Enter/Space → `click()` for hosts with no native activation (a `<label>`
   *  row). Natively-activatable elements are left to the browser — a
   *  synthesized click on a button would double-fire — and so is a key coming
   *  from a focusable descendant (the label's own checkbox). */
  onActivateKey(event: Event): void {
    const host = this.el.nativeElement;
    if (event.target !== host) return;
    if (/^(button|a|input|select|textarea|summary)$/i.test(host.tagName)) return;
    event.preventDefault();
    host.click();
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
