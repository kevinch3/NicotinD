import { Component, ElementRef, computed, input, output, viewChild } from '@angular/core';
import { LYRICS_OFFSET_STEP_MS } from '@nicotind/core';
import { SeekBarComponent } from '../../seek-bar/seek-bar.component';
import { NowPlayingVfxComponent } from '../now-playing-vfx/now-playing-vfx.component';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { TvNavGroupDirective } from '../../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../../directives/tv-nav-item.directive';
import { DEFAULT_PALETTE, type CoverPalette } from '../../../lib/cover-colors';
import type { WaveformData } from '../../../../types/core';

@Component({
  selector: 'app-now-playing-karaoke-fullscreen',
  imports: [
    SeekBarComponent,
    NowPlayingVfxComponent,
    TranslatePipe,
    TvNavGroupDirective,
    TvNavItemDirective,
  ],
  templateUrl: './now-playing-karaoke-fullscreen.component.html',
})
export class NowPlayingKaraokeFullscreenComponent {
  readonly colors = input<CoverPalette>(DEFAULT_PALETTE);
  readonly title = input('');
  readonly artist = input('');
  readonly browsing = input(false);
  readonly loading = input(false);
  readonly lines = input<{ text: string; timeMs: number }[]>([]);
  readonly activeLine = input(-1);
  readonly plainLyrics = input('');
  readonly currentLineText = input('');
  readonly nextLineText = input<string | null>(null);
  readonly lineAnimClass = input<'karaoke-line-anim-a' | 'karaoke-line-anim-b'>(
    'karaoke-line-anim-a',
  );
  readonly vocalsMuted = input(false);
  /**
   * Whether to render the seek bar. Off on the TV player: `app-seek-bar` is a
   * native range input, which eats all four arrow keys with no Tab to escape
   * by (#438), so the TV shows the ◀ ▶ hint in its place and seeks through
   * the route-scoped shortcut instead (#1134).
   */
  readonly seekBar = input(true);
  readonly progress = input(0);
  readonly duration = input(0);
  readonly buffered = input<{ start: number; end: number }[]>([]);
  readonly playing = input(false);
  readonly buffering = input(false);
  /** Precomputed band timeline driving the VFX backdrop (issue #643). */
  readonly waveform = input<WaveformData | null>(null);
  /** Stored sync correction; positive shows the lines later. */
  readonly offsetMs = input(0);
  /**
   * Whether to render the sync nudge. Defaults off for the same reason
   * `seekBar` does: the TV player mounts this component and drives it with a
   * D-pad roving tabindex, so two extra focusables would land in its
   * navigation tree without ever being reachable by a curator's ears.
   */
  readonly canSync = input(false);

  readonly exit = output<void>();
  /** Emits the delta in ms — the overlay doesn't own the stored offset. */
  readonly offsetNudged = output<number>();
  readonly offsetReset = output<void>();
  readonly browseToggle = output<void>();
  readonly interaction = output<void>();
  readonly lineSelected = output<number>();
  readonly vocalMuteToggle = output<void>();
  readonly seek = output<number>();
  readonly playPauseClicked = output<void>();
  readonly nextClicked = output<void>();
  readonly prevClicked = output<void>();

  readonly overlayRef = viewChild<ElementRef<HTMLElement>>('karaokeOverlay');
  /** The browse-mode scrollable line list — re-exposed so the shell's
   *  auto-scroll effect can reach it while fullscreen browse mode is active,
   *  mirroring `NowPlayingLyricsPanelComponent.lyricsScrollRef`. */
  readonly lyricsScrollRef = viewChild<ElementRef<HTMLElement>>('lyricsScroll');

  readonly step = LYRICS_OFFSET_STEP_MS;
  /** Signed seconds, e.g. `+1.25s`. Empty at zero, where the label reads "in sync". */
  readonly offsetLabel = computed(() => {
    const ms = this.offsetMs();
    if (!ms) return '';
    return `${ms > 0 ? '+' : '−'}${(Math.abs(ms) / 1000).toFixed(2)}s`;
  });

  formatTime(s: number): string {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }
}
