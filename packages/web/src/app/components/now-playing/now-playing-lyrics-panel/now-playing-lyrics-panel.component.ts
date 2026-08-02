import { Component, ElementRef, input, output, viewChild } from '@angular/core';
import { TranslatePipe } from '../../../pipes/translate.pipe';

@Component({
  selector: 'app-now-playing-lyrics-panel',
  imports: [TranslatePipe],
  templateUrl: './now-playing-lyrics-panel.component.html',
})
export class NowPlayingLyricsPanelComponent {
  readonly loading = input(false);
  readonly lines = input<{ text: string }[]>([]);
  readonly activeLine = input(-1);
  readonly plainLyrics = input('');
  readonly error = input(false);
  readonly fetching = input(false);

  readonly fullscreenRequested = output<void>();
  readonly fetchRequested = output<void>();

  readonly lyricsScrollRef = viewChild<ElementRef<HTMLElement>>('lyricsScroll');
}
