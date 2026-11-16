import { Component, computed, input, output } from '@angular/core';
import { IconComponent, type IconName } from '../icon/icon.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { TvNavGroupDirective } from '../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../directives/tv-nav-item.directive';

export interface IconTabItem {
  value: string;
  /** Recognisable without its label: an inactive tab shows nothing else. */
  icon: IconName;
  /** i18n key. */
  label: string;
  /** A count or a dot (`''`) that must stay visible while the label is hidden. */
  badge?: number | string | null;
  /** `data-testid` of this tab's button. */
  testid?: string;
  /** `data-testid` of this tab's badge, when a spec has to read the count. */
  badgeTestid?: string;
}

/**
 * What the bar is, which decides its roles:
 * - `nav`: a view switch whose buttons carry `aria-current` (the Library tabs).
 * - `tabs`: `tablist` / `tab` / `aria-selected`.
 * - `radio`: `radiogroup` / `radio` / `aria-checked`, for a setting with a few values.
 */
export type IconTabsVariant = 'nav' | 'tabs' | 'radio';

/**
 * The app's tab bar (#1668, docs/design-patterns.md "Tabs"): every tab shows its
 * icon, and only the active one also shows its label. An inactive label stays in
 * the DOM as `sr-only`, so the button keeps its accessible name, and every tab
 * has a `title`.
 */
@Component({
  selector: 'app-icon-tabs',
  imports: [IconComponent, TranslatePipe, TvNavGroupDirective, TvNavItemDirective],
  templateUrl: './icon-tabs.component.html',
})
export class IconTabsComponent {
  readonly items = input<readonly IconTabItem[]>([]);
  readonly active = input('');
  readonly variant = input<IconTabsVariant>('nav');
  /** `data-testid` of the bar. */
  readonly testid = input<string | null>(null);
  /** `data-testid` every label carries. */
  readonly labelTestid = input('icon-tab-label');
  /**
   * Fill the row below `sm` (the default, so seven Library tabs share a phone's
   * width). False keeps the bar as wide as its tabs, for a row whose empty space
   * has a job: the Now Playing strip is pulled up by it (#1679).
   */
  readonly fill = input(true);
  /** What `aria-current` says on the active `nav` tab: `page` when each tab is a URL. */
  readonly current = input<'true' | 'page'>('true');
  /** i18n key naming the bar for assistive tech (`tabs` and `radio`). */
  readonly label = input<string | null>(null);

  readonly selected = output<string>();

  readonly groupRole = computed(() =>
    this.variant() === 'tabs' ? 'tablist' : this.variant() === 'radio' ? 'radiogroup' : null,
  );
  readonly itemRole = computed(() =>
    this.variant() === 'tabs' ? 'tab' : this.variant() === 'radio' ? 'radio' : null,
  );

  hasBadge(item: IconTabItem): boolean {
    return item.badge !== undefined && item.badge !== null && item.badge !== 0;
  }
}
