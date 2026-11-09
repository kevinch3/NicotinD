import { Component, computed, input, output } from '@angular/core';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { LyricsSyncToolComponent } from '../lyrics-sync-tool/lyrics-sync-tool.component';

/**
 * The karaoke options group (#1656, docs/lyrics-options.md §5): one sheet that
 * lies over the lower part of the lyrics without pushing them, opened from the
 * Options button and closed every time its view opens. It holds the lyrics
 * settings, not vocal mute, which stays a header button (owner, 2026-11-09).
 *
 * Today: where the lyrics came from, and the sync tool. Fetch again (#1674) and
 * the timing editor (#1675) join it.
 */
@Component({
  selector: 'app-lyrics-options-sheet',
  imports: [TranslatePipe, LyricsSyncToolComponent],
  host: { '(keydown.escape)': 'closed.emit()' },
  templateUrl: './lyrics-options-sheet.component.html',
})
export class LyricsOptionsSheetComponent {
  readonly tone = input<'overlay' | 'panel'>('panel');
  /** `data-testid` prefix of the sync tool, kept per surface. */
  readonly syncTestid = input('lyrics-sync');
  /** The stored row's `source`, e.g. `lrclib`, `file-tag`, `user`. */
  readonly source = input<string | null>(null);
  readonly timed = input(false);
  readonly edited = input(false);
  readonly offsetMs = input(0);

  readonly closed = output<void>();
  readonly nudged = output<number>();
  readonly reset = output<void>();

  /** A known source by name; anything else as the server stored it. */
  readonly sourceName = computed(() => {
    const s = this.source();
    if (s === 'lrclib') return 'LRCLIB';
    if (s === 'file-tag') return null;
    return s;
  });
}
