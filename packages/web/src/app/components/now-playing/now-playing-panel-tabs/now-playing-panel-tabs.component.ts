import { Component, input, output } from '@angular/core';
import { IconComponent } from '../../icon/icon.component';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { TvNavGroupDirective } from '../../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../../directives/tv-nav-item.directive';

/**
 * Queue/Lyrics tab switcher for the Now Playing panel — a live queue-count
 * badge on the queue tab and a lyrics-availability dot on the lyrics tab
 * (self-suppressed once that tab is already active, see the template).
 * Renders `SettingsGroupHeaderComponent`-style icon-in-box headers as
 * interactive tab buttons (that component itself is static/non-clickable,
 * so its visual language is replicated inline rather than composed).
 */
@Component({
  selector: 'app-now-playing-panel-tabs',
  imports: [IconComponent, TranslatePipe, TvNavGroupDirective, TvNavItemDirective],
  templateUrl: './now-playing-panel-tabs.component.html',
})
export class NowPlayingPanelTabsComponent {
  readonly activePanel = input<'queue' | 'lyrics'>('queue');
  readonly queueCount = input(0);
  readonly hasLyrics = input(false);

  readonly panelSelected = output<'queue' | 'lyrics'>();
}
