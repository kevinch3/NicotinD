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
import { folderAudioFiles } from '../../lib/folder-utils';
import { FolderBrowserComponent } from '../folder-browser/folder-browser.component';

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
    FolderBrowserComponent,
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
  /** A scored hunt is still out: rows may yet upgrade or arrive. */
  readonly searching = input(false);
  /** Why the copies may be incomplete (source busy, offline), or null. */
  readonly notice = input<string | null>(null);
  /** The source can list a peer's whole folder (the `browse` capability). */
  readonly browsable = input(false);
  /** Tracks a "Get all" would queue; 0 hides it. */
  readonly downloadAllCount = input(0);

  readonly pick = output<CopyCandidate>();
  readonly close = output<void>();
  /** One file of a copy, picked on its own. */
  readonly pickFile = output<{ copy: CopyCandidate; file: { filename: string; size: number } }>();
  /** Files picked in the folder browser. */
  readonly browseDownload = output<{
    copy: CopyCandidate;
    files: Array<{ filename: string; size: number }>;
    path?: string;
  }>();
  readonly downloadAll = output<void>();

  readonly filesOpen = signal(false);
  readonly browsing = signal(false);

  private readonly chosenKey = signal<string | null>(null);
  readonly selected = computed(() => {
    const copies = this.copies();
    return copies.find((c) => c.key === this.chosenKey()) ?? copies[0] ?? null;
  });

  isSelected(copy: CopyCandidate): boolean {
    return this.selected()?.key === copy.key;
  }

  choose(copy: CopyCandidate): void {
    if (copy.key !== this.chosenKey()) this.browsing.set(false);
    this.chosenKey.set(copy.key);
  }

  toggleFiles(): void {
    this.filesOpen.update((v) => !v);
    this.browsing.set(false);
  }

  audioFiles(copy: CopyCandidate) {
    return folderAudioFiles(copy.folder);
  }

  fileName(path: string): string {
    return path.split(/[\\/]/).at(-1) ?? path;
  }

  fileSize(bytes: number): string {
    return formatBytes(bytes);
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
