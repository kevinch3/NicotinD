import { Directive, ElementRef, computed, inject } from '@angular/core';
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
    '(focusin)': 'onFocusIn()',
  },
})
export class TvNavItemDirective {
  private readonly el = inject(ElementRef<HTMLElement>);
  private readonly group = inject(TvNavGroupDirective, { optional: true });

  readonly tabIndex = computed(() => {
    if (!this.group) return 0;
    return this.group.items().indexOf(this) === this.group.activeIndex() ? 0 : -1;
  });

  onFocusIn(): void {
    this.group?.notifyFocused(this);
  }

  focusElement(): void {
    this.el.nativeElement.focus();
  }

  /** Whether `target` is this item's element or a descendant of it — used by
   *  the group's `onKeydown` to ignore arrow-key events that bubbled up from
   *  a focusable descendant that isn't itself an `appTvNavItem`. */
  containsEventTarget(target: EventTarget | null): boolean {
    return target instanceof Node && this.el.nativeElement.contains(target);
  }
}
