import { Component, effect, inject, untracked } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { PlayerComponent } from '../player/player.component';
import { PlayerService } from '../../services/player.service';

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
  imports: [RouterOutlet, PlayerComponent],
  template: `
    <div class="min-h-screen bg-theme-base text-theme-primary">
      <router-outlet />
      <!-- Headless on TV: PlayerComponent renders only its <audio> engine here
           (see its template's isTv gate). It is the playback engine, not just
           the bar — buffering, transcode fallback, false-ended recovery and the
           media session all live in it. -->
      <app-player />
    </div>
  `,
})
export class TvShellComponent {
  private readonly player = inject(PlayerService);
  private readonly router = inject(Router);

  constructor() {
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
  }
}
