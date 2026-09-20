import { Component, ElementRef, computed, input, output, viewChild } from '@angular/core';
import { LYRICS_OFFSET_STEP_MS } from '@nicotind/core';
import { TranslatePipe } from '../../../pipes/translate.pipe';

@Component({
  selector: 'app-now-playing-lyrics-panel',
  imports: [TranslatePipe],
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

  readonly fullscreenRequested = output<void>();
  readonly fetchRequested = output<void>();
  /** Emits the delta in ms, not the new absolute value — the panel doesn't own the state. */
  readonly offsetNudged = output<number>();
  readonly offsetReset = output<void>();

  readonly step = LYRICS_OFFSET_STEP_MS;
  /** Signed seconds, e.g. `+1.25s`. Empty at zero, where the label reads "in sync". */
  readonly offsetLabel = computed(() => {
    const ms = this.offsetMs();
    if (!ms) return '';
    return `${ms > 0 ? '+' : '−'}${(Math.abs(ms) / 1000).toFixed(2)}s`;
  });

  readonly lyricsScrollRef = viewChild<ElementRef<HTMLElement>>('lyricsScroll');
}
