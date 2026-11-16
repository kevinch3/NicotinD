import { Component, computed, input, output } from '@angular/core';
import { IconTabsComponent, type IconTabItem } from '../../icon-tabs/icon-tabs.component';
import { haptic } from '../../../lib/haptics';
import { DEFAULT_PLAYER_PANEL_TABS, type PlayerPanelTab } from '../player-panel-tabs';

/**
 * The Now Playing panel's tab strip, rendered from the tab registry
 * (`PLAYER_PANEL_TABS`, #1681) as the shared tab bar (#1668): an icon per tab,
 * a label on the shown one, and the tab's badge (the queue count, the lyrics dot).
 */
@Component({
  selector: 'app-now-playing-panel-tabs',
  imports: [IconTabsComponent],
  // `display: contents` so the host doesn't break the sheet's flex column —
  // the shell's flex container needs to see this component's own top-level
  // element as the flex item, and `contents` makes the host transparent.
  host: { class: 'contents' },
  templateUrl: './now-playing-panel-tabs.component.html',
})
export class NowPlayingPanelTabsComponent {
  readonly tabs = input<readonly PlayerPanelTab[]>(DEFAULT_PLAYER_PANEL_TABS);
  readonly activePanel = input<string>('queue');
  readonly queueCount = input(0);
  readonly hasLyrics = input(false);

  readonly panelSelected = output<string>();

  /** Each tab with its badge already worked out for the current state. */
  readonly view = computed(() =>
    this.tabs().map((tab) => {
      const active = tab.id === this.activePanel();
      const badge =
        tab.badge?.({ queueCount: this.queueCount(), hasLyrics: this.hasLyrics(), active }) ?? null;
      return {
        tab,
        active,
        count: typeof badge === 'number' ? badge : null,
        dot: badge === true,
      };
    }),
  );

  /** The registry as the tab bar takes it: a count stays a number, a dot is `''`. */
  readonly items = computed<IconTabItem[]>(() =>
    this.view().map(({ tab, count, dot }) => ({
      value: tab.id,
      icon: tab.icon,
      label: tab.labelKey,
      testid: tab.testid,
      badge: count ?? (dot ? '' : null),
      badgeTestid: `now-playing-${tab.id}-${count !== null ? 'count' : 'dot'}`,
    })),
  );

  /** Pressing the tab already shown changes the snap, not the tab: no `select` tick. */
  select(panel: string): void {
    if (panel !== this.activePanel()) haptic('select');
    this.panelSelected.emit(panel);
  }
}
