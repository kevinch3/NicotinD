import { Component, computed, inject, output } from '@angular/core';
import { TvNavItemDirective } from '../../../directives/tv-nav-item.directive';
import { PlayerService } from '../../../services/player.service';
import { nowPlayingHeading } from '../../../lib/now-playing-heading';
import { RemotePlaybackService } from '../../../services/remote-playback.service';
import { DeviceSwitcherComponent } from '../../device-switcher/device-switcher.component';
import { TranslatePipe } from '../../../pipes/translate.pipe';

@Component({
  selector: 'app-now-playing-header',
  imports: [DeviceSwitcherComponent, TranslatePipe, TvNavItemDirective],
  // `display: contents` so the host doesn't break the sheet's flex column —
  // the shell's flex container needs to see this component's own top-level
  // element as the flex item, and `contents` makes the host transparent.
  host: { class: 'contents' },
  templateUrl: './now-playing-header.component.html',
})
export class NowPlayingHeaderComponent {
  readonly player = inject(PlayerService);
  readonly remote = inject(RemotePlaybackService);

  /**
   * What this session actually is — a radio, an album, a playlist — rather than
   * the constant "NOW PLAYING" it used to read (#996). Radio wins over the
   * context it extended, because the radio is what chooses the next track.
   */
  readonly heading = computed(() =>
    nowPlayingHeading({
      radio: this.player.radio(),
      radioFilter: this.player.radioFilter(),
      context: this.player.context(),
      trackTitle: this.player.currentTrack()?.title ?? null,
    }),
  );

  readonly dragPointerDown = output<PointerEvent>();
}
