import { Component, computed, inject } from '@angular/core';
import { RemotePlaybackService } from '../../services/remote-playback.service';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { TvNavItemDirective } from '../../directives/tv-nav-item.directive';

/**
 * The "Playing on <device>" strip: the one persistent sign, on a controller,
 * that the audio is somewhere else. Accent-coloured so it reads as a state of
 * the player rather than a notification, and a button so the fix — moving the
 * audio — is one tap away (it opens the device switcher). Rendered only while a
 * session names another device; the player bar and the Now Playing sheet
 * both mount it. → docs/remote-playback.md
 */
@Component({
  selector: 'app-playing-elsewhere',
  imports: [TranslatePipe, TvNavItemDirective],
  templateUrl: './playing-elsewhere.component.html',
})
export class PlayingElsewhereComponent {
  readonly remote = inject(RemotePlaybackService);

  readonly name = computed(() => this.remote.activeDevice()?.name ?? '…');
  readonly reconnecting = computed(() => this.remote.activeDevice()?.pending === true);

  open(event: Event): void {
    event.stopPropagation();
    this.remote.setSwitcherOpen(true);
  }
}
