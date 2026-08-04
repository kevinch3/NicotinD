import { Component, ElementRef, input, output, viewChild } from '@angular/core';
import { SeekBarComponent } from '../../seek-bar/seek-bar.component';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { TvNavGroupDirective } from '../../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../../directives/tv-nav-item.directive';
import { DEFAULT_PALETTE, type CoverPalette } from '../../../lib/cover-colors';

@Component({
  selector: 'app-now-playing-karaoke-fullscreen',
  imports: [SeekBarComponent, TranslatePipe, TvNavGroupDirective, TvNavItemDirective],
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
  readonly progress = input(0);
  readonly duration = input(0);
  readonly buffered = input<{ start: number; end: number }[]>([]);
  readonly playing = input(false);
  readonly buffering = input(false);

  readonly exit = output<void>();
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

  formatTime(s: number): string {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }
}
