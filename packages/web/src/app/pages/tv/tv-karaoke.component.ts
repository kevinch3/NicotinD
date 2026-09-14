import { Component, DestroyRef, computed, effect, inject, output, signal } from '@angular/core';
import { PlayerService } from '../../services/player.service';
import { AuthService } from '../../services/auth.service';
import { ServerConfigService } from '../../services/server-config.service';
import { LyricsService } from '../../services/lyrics.service';
import { registerOverlayCloser } from '../../services/native/back-button.service';
import { NowPlayingKaraokeFullscreenComponent } from '../../components/now-playing/now-playing-karaoke-fullscreen/now-playing-karaoke-fullscreen.component';
import { KaraokeBrowseMode } from '../../lib/karaoke-browse';
import {
  DEFAULT_PALETTE,
  loadCoverPalette,
  scrollToActiveLine,
  type CoverPalette,
} from '../../lib/cover-colors';

/**
 * Karaoke on the TV player (#1134): the phone's fullscreen lyrics overlay,
 * mounted from `/player` under an `@if`, with the three things a remote needs
 * done differently.
 *
 * - **No seek bar.** `app-seek-bar` is a native range input — the #438 trap —
 *   so `seekBar` is off and ◀ ▶ keep seeking through the route-scoped shortcut,
 *   exactly as they do on the player behind this overlay.
 * - **Back closes the overlay, not the route.** Escape and hardware Back go
 *   through the shared `BackHandlerStack` (`registerOverlayCloser`, the #398
 *   modal shape); its lifetime is its open lifetime, so it registers once.
 * - **Nothing is forked.** Lyrics come from `LyricsService`, browse mode from
 *   `KaraokeBrowseMode`, the gradient from `loadCoverPalette` — the same three
 *   the phone sheet uses. This component only wires them to the local player.
 */
@Component({
  selector: 'app-tv-karaoke',
  standalone: true,
  imports: [NowPlayingKaraokeFullscreenComponent],
  template: `
    <app-now-playing-karaoke-fullscreen
      [colors]="colors()"
      [title]="title()"
      [artist]="artist()"
      [browsing]="browse.browsing()"
      [loading]="lyrics.loading()"
      [lines]="lyrics.lines()"
      [activeLine]="activeLine()"
      [plainLyrics]="lyrics.plain()"
      [currentLineText]="currentLineText()"
      [nextLineText]="nextLineText()"
      [lineAnimClass]="lineAnimClass()"
      [vocalsMuted]="player.vocalsMuted()"
      [progress]="progress()"
      [duration]="duration()"
      [buffered]="player.bufferedRanges()"
      [playing]="player.isPlaying()"
      [buffering]="player.bufferingVisible()"
      [seekBar]="false"
      (exit)="closed.emit()"
      (browseToggle)="browse.toggle()"
      (interaction)="browse.interact()"
      (lineSelected)="seekToLine($event)"
      (vocalMuteToggle)="player.toggleVocalMute()"
      (seek)="player.seek($event)"
      (playPauseClicked)="togglePlay()"
      (nextClicked)="player.playNext()"
      (prevClicked)="player.playPrev()"
    />
  `,
})
export class TvKaraokeComponent {
  readonly player = inject(PlayerService);
  readonly lyrics = inject(LyricsService);
  private readonly auth = inject(AuthService);
  private readonly server = inject(ServerConfigService);

  /** The overlay asked to close — its exit button, Escape, or hardware Back. */
  readonly closed = output<void>();

  readonly browse = new KaraokeBrowseMode();
  readonly colors = signal<CoverPalette>(DEFAULT_PALETTE);
  /** Alternates on every active-line change so the CSS keyframe restarts. */
  readonly lineAnimClass = signal<'karaoke-line-anim-a' | 'karaoke-line-anim-b'>(
    'karaoke-line-anim-a',
  );

  readonly title = computed(() => this.player.currentTrack()?.title ?? '');
  readonly artist = computed(() => this.player.currentTrack()?.artist ?? '');
  readonly activeLine = computed(() => this.lyrics.activeLineAt(this.player.currentTime() * 1000));
  readonly currentLineText = computed(() => this.lyrics.lines()[this.activeLine()]?.text ?? '');
  readonly nextLineText = computed(() => {
    const next = this.lyrics.lines()[this.activeLine() + 1];
    return next ? next.text : null;
  });
  readonly duration = computed(() => {
    const d = this.player.duration();
    return Number.isFinite(d) && d > 0 ? d : 0;
  });
  readonly progress = computed(() => {
    const t = this.player.currentTime();
    const d = this.duration();
    return Number.isFinite(t) && t >= 0 ? Math.min(t, d || t) : 0;
  });

  constructor() {
    registerOverlayCloser(() => this.closed.emit());
    inject(DestroyRef).onDestroy(() => this.browse.destroy());

    // Lyrics for whatever is playing — and for the next track when the queue
    // advances under the overlay. `ensureLoaded` is idempotent per track.
    effect(() => {
      const id = this.player.currentTrack()?.id;
      if (id) this.lyrics.ensureLoaded(id);
    });

    // The gradient comes from the cover. A palette that lands after the track
    // has already moved on is dropped rather than painted over the wrong song.
    effect(() => {
      const track = this.player.currentTrack();
      if (!track?.coverArt) {
        this.colors.set(DEFAULT_PALETTE);
        return;
      }
      const url = this.server.apiUrl(
        `/api/cover/${track.coverArt}?size=80&token=${this.auth.token()}`,
      );
      void loadCoverPalette(url).then((palette) => {
        if (this.player.currentTrack()?.id === track.id) this.colors.set(palette);
      });
    });

    // Replay the auto-follow line-change animation on every advance.
    effect(() => {
      this.activeLine();
      this.lineAnimClass.update((c) =>
        c === 'karaoke-line-anim-a' ? 'karaoke-line-anim-b' : 'karaoke-line-anim-a',
      );
    });

    // Browse mode: keep the active line centred in the list. A host query, not
    // a viewChild — signal view queries do not populate in the JIT harness.
    effect(() => {
      const active = this.activeLine();
      if (!this.browse.browsing() || active < 0) return;
      const list = document.querySelector<HTMLElement>(
        '[data-testid="karaoke-fullscreen-browse-list"]',
      );
      if (list) scrollToActiveLine(list, active);
    });

    // Focus the overlay so ▲ ▼ work at once — the phone sheet does the same.
    setTimeout(
      () => document.querySelector<HTMLElement>('[data-testid="karaoke-overlay"]')?.focus(),
      0,
    );
  }

  /** Tapping a line in browse mode seeks there and returns to auto-follow. */
  seekToLine(index: number): void {
    const line = this.lyrics.lines()[index];
    if (!line) return;
    this.player.seek(line.timeMs / 1000);
    this.browse.leave();
  }

  togglePlay(): void {
    if (this.player.isPlaying()) this.player.pause();
    else this.player.resume();
  }
}
