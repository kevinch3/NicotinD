import { Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { LibraryApiService } from '../../services/api/library-api.service';
import type { Song } from '../../services/api/api-types';

/**
 * Search-as-you-type song picker: song-agnostic-of-playlists reusable
 * component. Mirrors `LibrarySongsComponent`'s 250ms setTimeout/clearTimeout
 * debounce convention (no rxjs debounce operator).
 */
@Component({
  selector: 'app-song-picker',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './song-picker.component.html',
})
export class SongPickerComponent {
  private libraryApi = inject(LibraryApiService);

  /** Song ids to hide from results (e.g. songs already in the target playlist). */
  readonly excludeIds = input<string[]>([]);
  readonly add = output<Song>();

  readonly query = signal('');
  readonly results = signal<Song[]>([]);
  readonly searching = signal(false);
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  onQueryChange(q: string): void {
    this.query.set(q);
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    const trimmed = q.trim();
    if (trimmed.length < 2) {
      this.results.set([]);
      return;
    }
    this.debounceTimer = setTimeout(() => void this.runSearch(trimmed), 250);
  }

  private async runSearch(q: string): Promise<void> {
    this.searching.set(true);
    try {
      const excluded = new Set(this.excludeIds());
      const songs = await firstValueFrom(this.libraryApi.searchSongsAutocomplete(q, 8));
      this.results.set(songs.filter((s) => !excluded.has(s.id)));
    } catch {
      this.results.set([]);
    } finally {
      this.searching.set(false);
    }
  }

  pick(song: Song): void {
    this.add.emit(song);
    this.results.update((list) => list.filter((s) => s.id !== song.id));
  }
}
