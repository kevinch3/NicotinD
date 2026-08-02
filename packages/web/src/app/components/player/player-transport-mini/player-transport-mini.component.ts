import { Component, inject, input, output } from '@angular/core';
import { PlayerService } from '../../../services/player.service';
import { TvNavGroupDirective } from '../../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../../directives/tv-nav-item.directive';

/**
 * The shuffle/prev/play/next/repeat button cluster from the mini-player bar
 * (player.component). A pure relocation — the D-pad nav directives and
 * markup were already present/tested on this exact row before extraction
 * (see docs/web-ui.md "Player standardization"); this component just gives
 * it its own boundary, mirroring now-playing-transport.component.
 */
@Component({
  selector: 'app-player-transport-mini',
  imports: [TvNavGroupDirective, TvNavItemDirective],
  // `display: contents` so the host doesn't break the mini-player bar's flex
  // row — the shell's flex container needs to see this component's own
  // top-level element as the flex item, and `contents` makes the host
  // transparent.
  host: { class: 'contents' },
  templateUrl: './player-transport-mini.component.html',
})
export class PlayerTransportMiniComponent {
  readonly player = inject(PlayerService);

  readonly playing = input(false);
  readonly buffering = input(false);

  readonly prevClicked = output<void>();
  readonly playPauseClicked = output<void>();
  readonly nextClicked = output<void>();
}
