import { Component, inject, output } from '@angular/core';
import { PlayerService } from '../../../services/player.service';
import { RemotePlaybackService } from '../../../services/remote-playback.service';
import { DeviceSwitcherComponent } from '../../device-switcher/device-switcher.component';
import { TranslatePipe } from '../../../pipes/translate.pipe';

@Component({
  selector: 'app-now-playing-header',
  imports: [DeviceSwitcherComponent, TranslatePipe],
  // `display: contents` so the host doesn't break the sheet's flex column —
  // the shell's flex container needs to see this component's own top-level
  // element as the flex item, and `contents` makes the host transparent.
  host: { class: 'contents' },
  templateUrl: './now-playing-header.component.html',
})
export class NowPlayingHeaderComponent {
  readonly player = inject(PlayerService);
  readonly remote = inject(RemotePlaybackService);

  readonly dragPointerDown = output<PointerEvent>();
}
