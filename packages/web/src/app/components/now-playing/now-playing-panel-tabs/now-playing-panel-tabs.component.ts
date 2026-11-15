import { Component, computed, input, output } from '@angular/core';
import { IconComponent } from '../../icon/icon.component';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { TvNavGroupDirective } from '../../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../../directives/tv-nav-item.directive';
import { haptic } from '../../../lib/haptics';
import { DEFAULT_PLAYER_PANEL_TABS, type PlayerPanelTab } from '../player-panel-tabs';

/**
 * The Now Playing panel's tab strip, rendered from the tab registry
 * (`PLAYER_PANEL_TABS`, #1681): an icon-in-box per tab, its label, and the
 * tab's badge (the queue count after the label, the lyrics dot on the icon).
 */
@Component({
  selector: 'app-now-playing-panel-tabs',
  imports: [IconComponent, TranslatePipe, TvNavGroupDirective, TvNavItemDirective],
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

  /** Pressing the tab already shown changes the snap, not the tab: no `select` tick. */
  select(panel: string): void {
    if (panel !== this.activePanel()) haptic('select');
    this.panelSelected.emit(panel);
  }
}
