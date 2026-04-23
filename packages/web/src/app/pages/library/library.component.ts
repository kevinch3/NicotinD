import { Component, inject, signal, effect, OnInit } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService, type Album } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { TransferService } from '../../services/transfer.service';
import { ListControlsService, type SortOption } from '../../services/list-controls.service';
import { ListToolbarComponent } from '../../components/list-toolbar/list-toolbar.component';
import { resolveAlbumRoute, resolveGenreRoute } from '../../lib/route-utils';

type LibraryMode = 'albums' | 'artists' | 'genre';

@Component({
  selector: 'app-library',
  imports: [ListToolbarComponent, RouterLink],
  templateUrl: './library.component.html',
})
export class LibraryComponent implements OnInit {
  private api = inject(ApiService);
  readonly auth = inject(AuthService);
  private transferService = inject(TransferService);
  private listControls = inject(ListControlsService);

  // ─── Mode ─────────────────────────────────────────────────────────
  readonly modes = [
    { value: 'albums' as LibraryMode, label: 'Albums' },
    { value: 'artists' as LibraryMode, label: 'Artists' },
    { value: 'genre' as LibraryMode, label: 'Genre' },
  ];

  readonly libraryMode = signal<LibraryMode>(
    (localStorage.getItem('nicotind-library-mode') as LibraryMode) ?? 'albums',
  );

  setMode(mode: LibraryMode): void {
    this.libraryMode.set(mode);
    localStorage.setItem('nicotind-library-mode', mode);
    if (mode === 'artists' && !this.artists().length) this.fetchArtists();
    if (mode === 'genre' && !this.genres().length) this.fetchGenres();
  }

  // ─── Albums ───────────────────────────────────────────────────────
  readonly albums = signal<Album[]>([]);
  readonly loading = signal(true);

  readonly gridSortOptions: SortOption[] = [
    { field: 'name', label: 'Name' },
    { field: 'artist', label: 'Artist' },
    { field: 'year', label: 'Year' },
  ];

  readonly gridControls = this.listControls.connect({
    pageKey: 'library',
    items: this.albums,
    searchFields: ['name', 'artist'] as const,
    sortOptions: this.gridSortOptions,
  });

  // ─── Artists ──────────────────────────────────────────────────────
  readonly artists = signal<Array<{ id: string; name: string; albumCount: number; coverArt?: string }>>([]);
  readonly loadingArtists = signal(false);

  readonly artistSortOptions: SortOption[] = [
    { field: 'name', label: 'Name' },
    { field: 'albumCount', label: 'Albums' },
  ];

  readonly artistControls = this.listControls.connect({
    pageKey: 'library-artists',
    items: this.artists,
    searchFields: ['name'] as const,
    sortOptions: this.artistSortOptions,
    defaultSort: 'name',
  });

  // ─── Genre ────────────────────────────────────────────────────────
  readonly genres = signal<Array<{ value: string; songCount: number; albumCount: number }>>([]);
  readonly loadingGenres = signal(false);

  // ─── Lifecycle ────────────────────────────────────────────────────
  private dirtyEffect = effect(() => {
    if (this.transferService.libraryDirty()) {
      this.transferService.clearLibraryDirty();
      this.fetchAlbums();
    }
  });

  async ngOnInit(): Promise<void> {
    await this.fetchAlbums();
    const mode = this.libraryMode();
    if (mode === 'artists') this.fetchArtists();
    if (mode === 'genre') this.fetchGenres();
  }

  // ─── Data fetchers ───────────────────────────────────────────────
  private async fetchAlbums(): Promise<void> {
    this.loading.set(true);
    try {
      const data = await firstValueFrom(this.api.getAlbums('newest', 80));
      this.albums.set(data);
    } catch { /* ignore */ }
    finally { this.loading.set(false); }
  }

  async fetchArtists(): Promise<void> {
    if (this.loadingArtists()) return;
    this.loadingArtists.set(true);
    try {
      const data = await firstValueFrom(this.api.getArtists());
      this.artists.set(data.map(a => ({ ...a, albumCount: a.albumCount ?? 0 })));
    } catch { /* ignore */ }
    finally { this.loadingArtists.set(false); }
  }

  async fetchGenres(): Promise<void> {
    if (this.loadingGenres()) return;
    this.loadingGenres.set(true);
    try {
      const data = await firstValueFrom(this.api.getGenres());
      this.genres.set(data.sort((a, b) => b.songCount - a.songCount));
    } catch { /* ignore */ }
    finally { this.loadingGenres.set(false); }
  }

  getAlbumLink(id: string) {
    return resolveAlbumRoute(id);
  }

  getGenreLink(slug: string) {
    return resolveGenreRoute(slug);
  }
}
