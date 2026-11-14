import { Component, computed, input, output } from '@angular/core';
import { IconComponent } from '../icon/icon.component';
import { SourceChipComponent, type ChipSource } from '../source-chip/source-chip.component';
import { OverflowRevealDirective } from '../../directives/overflow-reveal.directive';
import { TranslatePipe } from '../../pipes/translate.pipe';

/**
 * Where one track's Get is. `queued` is a link job handed off; `done` is on disk,
 * not yet filed; `failed` keeps its Get, to try again.
 */
export type TrackRowState = 'idle' | 'working' | 'queued' | 'done' | 'failed';

/**
 * One track on the Get page, whichever lane found it: two lines (what it is,
 * then where it comes from), and on the right the same slots as the album
 * card — the action, then Cancel while a job runs.
 */
@Component({
  selector: 'app-get-track-row',
  standalone: true,
  imports: [IconComponent, SourceChipComponent, OverflowRevealDirective, TranslatePipe],
  host: { class: 'block' },
  templateUrl: './get-track-row.component.html',
})
export class GetTrackRowComponent {
  // Not `input.required()`: see the note in album-tile.component.ts.
  readonly title = input('');
  readonly subtitle = input('');
  /** `FLAC · 28 MB · 5:12`; what decides between copies. */
  readonly facts = input('');
  readonly source = input<ChipSource | null>(null);
  readonly sourceLabel = input('');
  readonly state = input<TrackRowState>('idle');
  readonly percent = input(0);
  /** The running job, when the row may cancel it. */
  readonly cancelJobId = input<string | null>(null);
  /** Other copies of the same track the sources hold; 0 or 1 says nothing. */
  readonly copies = input(0);
  /** A link Get opens the source instead (e.g. Spotify without a resolver). */
  readonly opensExternally = input(false);
  /** Lossless pick that will be stored as Opus at this bitrate; 0 when not. */
  readonly transcodeKbps = input(0);
  /** Root testid; its parts are suffixed from it (`-get`, `-cancel`). */
  readonly testid = input('acquire-result');

  readonly get = output<void>();
  readonly cancel = output<string>();

  readonly busy = computed(() => this.state() === 'working');
  readonly statusKey = computed(() => {
    switch (this.state()) {
      case 'done':
        return 'acquire.downloadedCheck';
      case 'queued':
        return 'acquire.queuedCheck';
      case 'failed':
        return 'acquire.errorShort';
      default:
        return null;
    }
  });
}
