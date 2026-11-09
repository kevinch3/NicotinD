import { Component, ElementRef, input, output, signal, viewChild } from '@angular/core';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { LyricsOptionsSheetComponent } from '../lyrics-options-sheet/lyrics-options-sheet.component';

@Component({
  selector: 'app-now-playing-lyrics-panel',
  imports: [TranslatePipe, LyricsOptionsSheetComponent],
  // `display: contents` so the host doesn't break the sheet's flex column —
  // the shell's flex container needs to see this component's own top-level
  // element as the flex item, and `contents` makes the host transparent.
  host: { class: 'contents' },
  templateUrl: './now-playing-lyrics-panel.component.html',
})
export class NowPlayingLyricsPanelComponent {
  readonly loading = input(false);
  readonly lines = input<{ text: string }[]>([]);
  readonly activeLine = input(-1);
  readonly plainLyrics = input('');
  readonly error = input(false);
  readonly fetching = input(false);
  /** Stored sync correction; positive shows the lines later. */
  readonly offsetMs = input(0);
  /** Whether this viewer may change it — the control is hidden, not disabled,
   *  for everyone else, so nobody is offered a button that cannot work. */
  readonly canSync = input(false);
  /** The stored row's source and whether someone edited it, for the options sheet. */
  readonly lyricsSource = input<string | null>(null);
  readonly lyricsEdited = input(false);
  /** The options sheet; closed whenever the panel is shown again (#1656). */
  readonly optionsOpen = signal(false);

  readonly fullscreenRequested = output<void>();
  readonly fetchRequested = output<void>();
  /** Emits the delta in ms, not the new absolute value — the panel doesn't own the state. */
  readonly offsetNudged = output<number>();
  readonly offsetReset = output<void>();

  readonly lyricsScrollRef = viewChild<ElementRef<HTMLElement>>('lyricsScroll');
}
