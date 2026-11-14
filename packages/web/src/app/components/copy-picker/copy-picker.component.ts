import { Component, computed, input, output, signal } from '@angular/core';
import { registerOverlayCloser } from '../../services/native/back-button.service';
import { BottomChromeSafeDirective } from '../../directives/bottom-chrome-safe.directive';
import { OverflowRevealDirective } from '../../directives/overflow-reveal.directive';
import { TvNavGroupDirective } from '../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../directives/tv-nav-item.directive';
import { IconComponent } from '../icon/icon.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { formatBytes } from '../../lib/disk-usage';
import { copyFolderName, type CopyCandidate } from '../../lib/copy-candidate';

/**
 * "Choose a copy": every copy the sources hold of one work, best first, with the
 * top one preselected. A drawer at the right on a wide screen, so the grid it was
 * opened from stays in view; a bottom sheet on a phone.
 */
@Component({
  selector: 'app-copy-picker',
  standalone: true,
  imports: [
    BottomChromeSafeDirective,
    OverflowRevealDirective,
    TvNavGroupDirective,
    TvNavItemDirective,
    IconComponent,
    TranslatePipe,
  ],
  templateUrl: './copy-picker.component.html',
})
export class CopyPickerComponent {
  constructor() {
    registerOverlayCloser(() => this.close.emit());
  }

  // Not `input.required()`: see the note in album-tile.component.ts.
  readonly title = input('');
  readonly artist = input('');
  /** The work's live status (`albumHuntLabel`), or empty when idle. */
  readonly status = input('');
  readonly copies = input<readonly CopyCandidate[]>([]);
  /** Another Get for this work is running: picking replaces it. */
  readonly replaces = input(false);

  readonly pick = output<CopyCandidate>();
  readonly close = output<void>();

  private readonly chosenKey = signal<string | null>(null);
  readonly selected = computed(() => {
    const copies = this.copies();
    return copies.find((c) => c.key === this.chosenKey()) ?? copies[0] ?? null;
  });

  isSelected(copy: CopyCandidate): boolean {
    return this.selected()?.key === copy.key;
  }

  choose(copy: CopyCandidate): void {
    this.chosenKey.set(copy.key);
  }

  confirm(): void {
    const copy = this.selected();
    if (copy) this.pick.emit(copy);
  }

  completeness(c: CopyCandidate): string {
    return c.totalTracks ? `${Math.min(c.tracks, c.totalTracks)}/${c.totalTracks}` : `${c.tracks}`;
  }

  size(c: CopyCandidate): string {
    return formatBytes(c.sizeBytes);
  }

  readonly folderName = copyFolderName;
}
