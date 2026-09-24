import { Component, computed, inject, signal } from '@angular/core';
import { Location } from '@angular/common';
import { PlayerService } from '../../services/player.service';
import { AuthService } from '../../services/auth.service';
import { RemotePlaybackService } from '../../services/remote-playback.service';
import { CoverArtComponent } from '../../components/cover-art/cover-art.component';
import { NowPlayingTvQueueComponent } from '../../components/now-playing/now-playing-tv-queue/now-playing-tv-queue.component';
import { TvKaraokeComponent } from './tv-karaoke.component';
import { TvNavGroupDirective } from '../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../directives/tv-nav-item.directive';
import { TranslatePipe } from '../../pipes/translate.pipe';

/**
 * The 10-foot player, as a route rather than a sheet.
 *
 * On the phone Now Playing is a sheet inside the layout, permanently mounted
 * and translated off-screen — which is what let its blurred backdrop bleed over
 * every other route (#439). Here it is an ordinary route: it exists when you're
 * looking at it and not otherwise, so the translate machinery, the drag-to-open
 * gesture, the grab notch and the `html.tv-build` sheet overrides all become
 * unnecessary.
 *
 * There is deliberately **no seek bar**: a native range input eats all four
 * arrow keys and a remote has no Tab to escape with (#438). ◀ ▶ seek instead,
 * bound by `KeyboardShortcutsService` only while this route is active.
 */
@Component({
  selector: 'app-tv-player',
  standalone: true,
  imports: [
    CoverArtComponent,
    NowPlayingTvQueueComponent,
    TvKaraokeComponent,
    TvNavGroupDirective,
    TvNavItemDirective,
    TranslatePipe,
  ],
  templateUrl: './tv-player.component.html',
})
export class TvPlayerComponent {
  readonly player = inject(PlayerService);
  readonly auth = inject(AuthService);
  readonly remote = inject(RemotePlaybackService);
  private readonly location = inject(Location);

  readonly track = this.player.currentTrack;
  readonly nextUp = computed(() => this.player.queue()[0] ?? null);

  /** The D-pad queue overlay (#399), previously reachable only from the phone
   *  sheet — so a TV build shipped it as dead code and showed one Next-up line
   *  with no way to see or change what followed (#1127). */
  readonly queueOpen = signal(false);

  /** The karaoke overlay (#1134) — the phone sheet's fullscreen lyrics, on a
   *  route that never had a lyrics surface of its own. */
  readonly karaokeOpen = signal(false);

  /** The audio is on another device: the transport here drives it, and OK on
   *  the strip opens the chooser to bring it back (#1128). */
  readonly elsewhere = this.remote.playingElsewhere;
  readonly elsewhereName = computed(() => this.remote.activeDevice()?.name ?? '…');

  /** Blurred cover behind the sheet. Safe to bind unconditionally here — unlike
   *  the phone sheet, this component only exists while the route is active. */
  readonly backdrop = computed(() => {
    const art = this.track()?.coverArt;
    return art ? `url(/api/cover/${art}?size=600&token=${this.auth.mediaToken()})` : null;
  });

  togglePlay(): void {
    if (this.player.isPlaying()) this.player.pause();
    else this.player.resume();
  }

  openDevices(): void {
    this.remote.setSwitcherOpen(true);
  }

  closeKaraoke(): void {
    this.karaokeOpen.set(false);
    // Focus-restore to the row that opened it (the MenuPanel discipline), once
    // the overlay has left the DOM — a host query, not a viewChild.
    setTimeout(() => document.querySelector<HTMLElement>('[data-testid="tv-lyrics"]')?.focus(), 0);
  }

  onQueueJump(index: number): void {
    this.player.jumpToQueueIndex(index);
    this.queueOpen.set(false);
  }

  onQueueRemove(index: number): void {
    this.player.removeFromQueue(index);
  }

  back(): void {
    this.location.back();
  }
}
