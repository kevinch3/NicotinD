import { Component, HostBinding, Input } from '@angular/core';
import { IconComponent } from '../icon/icon.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { OverflowRevealDirective } from '../../directives/overflow-reveal.directive';
import type { TrackAction } from '../track-row/track-row.component';

/**
 * One row of an action menu: its icon, its label and its destructive style
 * (#2005). Every menu that lists `TrackAction`s draws them through this, so an
 * addition to a menu row (an icon, a divider, a submenu arrow) is made once.
 *
 * An attribute on the `<button>` itself, not an element around it: menu rows
 * have to stay direct children of `[menuPanel]`, which is what the phone
 * sheet's 44px rule and the panel's own focus and D-pad handling select on.
 * The caller keeps `(click)`, because closing differs per menu.
 *
 * Classic `@Input()`s on purpose: the web unit harness does not bind signal
 * inputs of a nested component (src/testing/signal-input.ts).
 */
@Component({
  selector: 'button[appMenuItem]',
  imports: [IconComponent, OverflowRevealDirective, TranslatePipe],
  template: `
    <span class="flex w-4 shrink-0 items-center justify-center" data-menu-item-icon>
      @if (action.icon) {
        <app-icon [name]="action.icon" [size]="16" />
      }
    </span>
    <span appOverflowReveal class="min-w-0 flex-1 truncate">{{
      action.labelKey ? (action.labelKey | t) : action.label
    }}</span>
  `,
  host: {
    type: 'button',
    class:
      'flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors hover:bg-theme-hover disabled:opacity-50',
  },
})
export class MenuItemComponent {
  /** The action this row runs and describes. */
  @Input({ required: true, alias: 'appMenuItem' }) action!: TrackAction;
  /** `track-action-`, `entity-action-` or `album-action-`: what e2e selects on. */
  @Input() testidPrefix = 'track-action-';
  /** A row in a phone sheet or a touch-first menu is 44px tall. */
  @Input() tall = false;

  @HostBinding('attr.data-testid') get testid(): string {
    return this.testidPrefix + this.action.label;
  }
  @HostBinding('attr.data-icon') get iconName(): string | null {
    return this.action.icon ?? null;
  }
  @HostBinding('class.min-h-11') get isTall(): boolean {
    return this.tall;
  }
  @HostBinding('class.text-status-error') get destructive(): boolean {
    return !!this.action.destructive;
  }
  @HostBinding('class.text-theme-secondary') get plain(): boolean {
    return !this.action.destructive;
  }
}
