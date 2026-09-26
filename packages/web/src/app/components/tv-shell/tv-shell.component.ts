import { Component, effect, inject, untracked } from '@angular/core';
import { APP_VERSION } from '../../app.config';
import { AuthService } from '../../services/auth.service';
import { Router, RouterOutlet } from '@angular/router';
import { PlayerComponent } from '../player/player.component';
import { PlayerService } from '../../services/player.service';
import { RemotePlaybackService } from '../../services/remote-playback.service';
import { UpdateBannerComponent } from '../update-banner/update-banner.component';
import { TvDevicePickerComponent } from '../tv-device-picker/tv-device-picker.component';
import { TvProfileListenerService } from '../../services/tv-profile-listener.service';

/**
 * The TV chrome: a router outlet and a headless audio engine.
 *
 * Replaces `LayoutComponent`'s header + `app-bottom-nav` on a TV build. Five
 * nav destinations and a persistent mini-player are phone idioms — a remote
 * wants a few large targets and a player you navigate *to*. See docs/tv-ux.md.
 *
 * `app-player` stays, rendering no chrome: it owns the <audio> elements and the
 * playback machinery, so removing it removes audio itself.
 */
@Component({
  selector: 'app-tv-shell',
  standalone: true,
  imports: [RouterOutlet, PlayerComponent, UpdateBannerComponent, TvDevicePickerComponent],
  template: `
    <div class="min-h-screen bg-theme-base text-theme-primary">
      <!-- Who and what, on every TV screen (#1404): nothing in the tree said
           which account this box was on or what it ran. A fixed-height row in
           the flow, not an absolute overlay — every page starts its content at
           the same y, and an overlay there sat behind the Home nav and the
           Settings heading. The player's backdrop is position: fixed, so it bleeds
           under this row instead of leaving a black band above it. -->
      <div
        class="relative z-20 h-8 px-[4vw] flex items-center justify-between text-xs
               text-theme-muted pointer-events-none select-none"
        data-testid="tv-status"
        aria-hidden="true"
      >
        <span data-testid="tv-status-user">{{ auth.username() }}</span>
        <span data-testid="tv-status-version">v{{ version }}</span>
      </div>
      <router-outlet />
      <!-- Headless on TV: PlayerComponent renders only its <audio> engine here
           (see its template's isTv gate). It is the playback engine, not just
           the bar — buffering, transcode fallback, false-ended recovery and the
           media session all live in it. -->
      <app-player />
      <!-- The D-pad output chooser, on the same switcherOpen flag the phone
           popover uses so every caller opens the right shape for its surface
           (#1128). Mounted on the shell, not a page, so it survives a route
           change and is reachable from wherever the strip was pressed. -->
      @if (remote.switcherOpen()) {
        <app-tv-device-picker />
      }
      <!-- The update surface the TV tree used to lack entirely (#1126): the
           banner lived only in layout.component.html, so a TV build had no sign
           an update was applying. -->
      <app-update-banner />
    </div>
  `,
})
export class TvShellComponent {
  private readonly player = inject(PlayerService);
  readonly remote = inject(RemotePlaybackService);
  readonly auth = inject(AuthService);
  readonly version = inject(APP_VERSION);
  private readonly router = inject(Router);
  // Exists so every stored person can cast to this TV, #1406.
  private readonly castListeners = inject(TvProfileListenerService);

  constructor() {
    // Radio is always on for a TV build. The five TV screens carry no radio
    // control — the toggle lives in the phone transport and the radio chip — so
    // a remembered `radio = false` could never be turned back on from the
    // couch, and every queue (album, artist, genre, even a vibe tile) ended in
    // silence (#1127). Endless playback is the 10-foot expectation; there is no
    // "off" worth preserving when there is no way back.
    this.player.ensureRadioOn();

    // `nowPlayingOpen` is the phone sheet's open flag, and existing callers
    // (the radio landing's vibe/resume actions, the song menu) set it to mean
    // "show the user what's playing now". On TV there is no sheet, so the shell
    // adapts that intent into a route change — which keeps every one of those
    // callers working unmodified rather than forking them for TV.
    //
    // It's reset immediately so a later open request fires the effect again;
    // `untracked` keeps the reset from re-entering this effect.
    effect(() => {
      if (!this.player.nowPlayingOpen()) return;
      untracked(() => {
        this.player.nowPlayingOpen.set(false);
        void this.router.navigate(['/player']);
      });
    });

    // A cast that lands here shows itself (#1128). Picking this TV from a
    // phone's device switcher used to start audio and change nothing on
    // screen — the 10-foot display stayed on Home with no artwork, no title
    // and no transport for the track it had just started playing.
    //
    // `castsReceived`, not `isActiveDevice()`: this device claims the output
    // when it plays locally too, and `isAudioOutput` is true with no session at
    // all — so the state cannot tell "a controller cast to me" from "I am
    // playing", and keying off it would yank the screen to the player on every
    // ordinary play. Only a server message bumps the counter.
    effect(() => {
      if (this.remote.castsReceived() === 0) return;
      untracked(() => {
        if (this.router.url.startsWith('/player')) return;
        void this.router.navigate(['/player']);
      });
    });
  }
}
