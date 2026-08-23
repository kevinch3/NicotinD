import { Component, inject, input, output } from '@angular/core';
import { PlayerService } from '../../../services/player.service';
import { isTvUi } from '../../../lib/platform';
import { SeekBarComponent } from '../../seek-bar/seek-bar.component';
import { NowPlayingWaveformComponent } from '../now-playing-waveform/now-playing-waveform.component';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { TvNavGroupDirective } from '../../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../../directives/tv-nav-item.directive';
import type { WaveformData } from '../../../../types/core';

@Component({
  selector: 'app-now-playing-transport',
  imports: [
    SeekBarComponent,
    NowPlayingWaveformComponent,
    TranslatePipe,
    TvNavGroupDirective,
    TvNavItemDirective,
  ],
  // `display: contents` so the host doesn't break the sheet's flex column —
  // the shell's flex container needs to see this component's own top-level
  // element as the flex item, and `contents` makes the host transparent.
  host: { class: 'contents' },
  templateUrl: './now-playing-transport.component.html',
})
export class NowPlayingTransportComponent {
  readonly player = inject(PlayerService);

  // TV player keeps only prev/play/next: shuffle and repeat are cut from the
  // 10-foot transport (D-pad economy; the queue is radio/album-driven there).
  readonly isTv = isTvUi();

  readonly progress = input(0);
  readonly duration = input(0);
  readonly buffered = input<{ start: number; end: number }[]>([]);
  readonly playing = input(false);
  readonly buffering = input(false);
  /** Precomputed waveform (issue #643); null → only the seek bar renders. */
  readonly waveform = input<WaveformData | null>(null);

  readonly seek = output<number>();
  readonly playPauseClicked = output<void>();
  readonly nextClicked = output<void>();
  readonly prevClicked = output<void>();

  formatTime(s: number): string {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }
}
