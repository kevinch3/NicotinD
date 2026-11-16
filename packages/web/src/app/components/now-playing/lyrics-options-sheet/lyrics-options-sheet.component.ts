import { Component, computed, input, output } from '@angular/core';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import type { LyricsTryResult } from '../../../services/lyrics.service';
import { LyricsSyncToolComponent } from '../lyrics-sync-tool/lyrics-sync-tool.component';

/**
 * The karaoke options group (#1656, docs/lyrics-options.md §5): one sheet that
 * lies over the lower part of the lyrics without pushing them, opened from the
 * Options button and closed every time its view opens. It holds the lyrics
 * settings, not vocal mute, which stays a header button (owner, 2026-11-09).
 *
 * Today: where the lyrics came from (with "n of m" once a walk wrote the row),
 * "Try another source" (#1674) and the sync tool. The timing editor (#1675)
 * joins it.
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
  /** "Try another source" state; null hides the button (the default, and TV). */
  readonly tryState = input<LyricsTryState | null>(null);

  readonly tryAnother = output<void>();
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

  /** A source id as the sheet names it. */
  nameOf(source: string): string {
    return source === 'lrclib' ? 'LRCLIB' : source;
  }
}

/** What the sheet needs to offer and report "Try another source" (#1674). */
export interface LyricsTryState {
  /** Where the stored words sit among the candidates, when a walk wrote them. */
  walk: { index: number; total: number } | null;
  busy: boolean;
  result: LyricsTryResult | null;
}
