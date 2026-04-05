import { Component, inject, signal, computed, effect, OnInit } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService, type Album, type AlbumDetail } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { PlayerService, type Track } from '../../services/player.service';
import { TransferService } from '../../services/transfer.service';
import { ListControlsService, type SortOption } from '../../services/list-controls.service';
import { ListToolbarComponent } from '../../components/list-toolbar/list-toolbar.component';
import { TrackRowComponent } from '../../components/track-row/track-row.component';
import { toTrack } from '../../lib/track-utils';

@Component({
  selector: 'app-library',
  imports: [ListToolbarComponent, TrackRowComponent],
  template: `
    <!-- Album detail view -->
    @if (selectedAlbum()) {
      <div class="max-w-6xl mx-auto px-4 py-5 md:px-6 md:py-8">
        <button (click)="selectedAlbum.set(null)"
          class="text-sm text-theme-muted hover:text-theme-secondary transition mb-6">
          &larr; Back to library
        </button>

        <div class="flex flex-col sm:flex-row items-center sm:items-end gap-6 mb-8 text-center sm:text-left">
          @if (selectedAlbum()!.coverArt) {
            <img [src]="'/api/cover/' + selectedAlbum()!.coverArt + '?size=300&token=' + auth.token()"
              alt="" class="w-48 h-48 rounded-lg object-cover flex-shrink-0" />
          } @else {
            <div class="w-48 h-48 rounded-lg bg-theme-surface-2 flex-shrink-0"></div>
          }
          <div class="flex flex-col justify-end">
            <h1 class="text-2xl font-bold text-theme-primary">{{ selectedAlbum()!.name }}</h1>
            <p class="text-theme-secondary mt-1">{{ selectedAlbum()!.artist }}</p>
            @if (selectedAlbum()!.year) {
              <p class="text-theme-muted text-sm mt-1">{{ selectedAlbum()!.year }}</p>
            }
            <div class="flex justify-center sm:justify-start gap-3 mt-4">
              <button (click)="playAlbum()"
                class="px-5 py-2 rounded-lg bg-zinc-100 text-zinc-900 text-sm font-semibold hover:bg-zinc-200 transition">
                Play Album
              </button>
              <!-- TODO: Preserve All (Phase 5) -->
            </div>
          </div>
        </div>

        @if (detailControls.isToolbarVisible()) {
          <app-list-toolbar
            [searchText]="detailControls.searchText()"
            [sortField]="detailControls.sortField()"
            [sortDirection]="detailControls.sortDirection()"
            [sortOptions]="detailSortOptions"
            [resultCount]="detailControls.filtered().length"
            (searchChange)="detailControls.setSearchText($event)"
            (sortFieldChange)="detailControls.setSortField($event)"
            (toggleDirection)="detailControls.toggleSortDirection()"
            (dismiss)="detailControls.hideToolbar()"
          />
        }

        <div>
          @for (song of detailControls.filtered(); track song.id) {
            <app-track-row
              [track]="toTrackFromSong(song)"
              [indexLabel]="song.track ?? ''"
              [duration]="song.duration"
              (play)="playSong(song)"
            />
          }
        </div>
      </div>
    } @else {
      <!-- Album grid view -->
      <div class="max-w-6xl mx-auto px-4 py-5 md:px-6 md:py-8">
        <div class="flex items-center gap-3 mb-6">
          <h1 class="text-lg font-semibold text-theme-primary">Library</h1>
          <button (click)="gridControls.showToolbar()" class="p-1 text-theme-muted hover:text-theme-secondary transition" title="Search (Ctrl+F)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
          </button>
        </div>

        @if (gridControls.isToolbarVisible()) {
          <app-list-toolbar
            [searchText]="gridControls.searchText()"
            [sortField]="gridControls.sortField()"
            [sortDirection]="gridControls.sortDirection()"
            [sortOptions]="gridSortOptions"
            [resultCount]="gridControls.filtered().length"
            (searchChange)="gridControls.setSearchText($event)"
            (sortFieldChange)="gridControls.setSortField($event)"
            (toggleDirection)="gridControls.toggleSortDirection()"
            (dismiss)="gridControls.hideToolbar()"
          />
        }

        @if (loading()) {
          <div class="text-center py-20">
            <span class="inline-block w-5 h-5 border-2 border-theme border-t-zinc-300 rounded-full animate-spin"></span>
          </div>
        }

        @if (!loading() && albums().length === 0) {
          <p class="text-center text-theme-muted py-20">
            No albums yet. Download some music to get started!
          </p>
        }

        <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          @for (album of gridControls.filtered(); track album.id) {
            <button (click)="openAlbum(album)" [disabled]="loadingAlbum()"
              class="p-3 rounded-lg bg-theme-surface/30 hover:bg-theme-surface-2/50 transition text-left">
              @if (album.coverArt) {
                <img [src]="'/api/cover/' + album.coverArt + '?size=300&token=' + auth.token()"
                  alt="" class="w-full aspect-square rounded object-cover mb-2" />
              } @else {
                <div class="w-full aspect-square rounded bg-theme-surface-2 mb-2"></div>
              }
              <p class="text-sm text-theme-primary truncate">{{ album.name }}</p>
              <p class="text-xs text-theme-muted truncate">
                {{ album.artist }}{{ album.year ? ' · ' + album.year : '' }}
              </p>
            </button>
          }
        </div>
      </div>
    }
  `,
})
export class LibraryComponent implements OnInit {
  private api = inject(ApiService);
  readonly auth = inject(AuthService);
  private player = inject(PlayerService);
  private transferService = inject(TransferService);
  private listControls = inject(ListControlsService);

  readonly albums = signal<Album[]>([]);
  readonly loading = signal(true);
  readonly selectedAlbum = signal<AlbumDetail | null>(null);
  readonly loadingAlbum = signal(false);

  // For album detail track list
  readonly detailSongs = computed(() => {
    const album = this.selectedAlbum();
    return album?.song ?? [];
  });

  readonly gridSortOptions: SortOption[] = [
    { field: 'name', label: 'Name' },
    { field: 'artist', label: 'Artist' },
    { field: 'year', label: 'Year' },
  ];

  readonly detailSortOptions: SortOption[] = [
    { field: 'track', label: 'Track #' },
    { field: 'title', label: 'Title' },
    { field: 'artist', label: 'Artist' },
  ];

  readonly gridControls = this.listControls.connect({
    pageKey: 'library',
    items: this.albums,
    searchFields: ['name', 'artist'] as const,
    sortOptions: this.gridSortOptions,
  });

  readonly detailControls = this.listControls.connect({
    pageKey: 'library-album',
    items: this.detailSongs,
    searchFields: ['title', 'artist'] as const,
    sortOptions: this.detailSortOptions,
    defaultSort: 'track',
  });

  // Auto-refresh on libraryDirty
  private dirtyEffect = effect(() => {
    if (this.transferService.libraryDirty()) {
      this.transferService.clearLibraryDirty();
      this.fetchAlbums();
    }
  });

  ngOnInit(): void {
    this.fetchAlbums();
  }

  async openAlbum(album: Album): Promise<void> {
    this.loadingAlbum.set(true);
    try {
      const detail = await firstValueFrom(this.api.getAlbum(album.id));
      this.selectedAlbum.set(detail);
    } catch { /* ignore */ }
    finally { this.loadingAlbum.set(false); }
  }

  playSong(song: { id: string; title: string; artist: string; duration?: number; track?: number; coverArt?: string }): void {
    this.player.play(toTrack(song, this.selectedAlbum()?.name));
  }

  playAlbum(): void {
    const album = this.selectedAlbum();
    if (!album?.song?.length) return;
    const tracks = album.song.map((s): Track => ({
      id: s.id,
      title: s.title,
      artist: s.artist,
      album: album.name,
      coverArt: s.coverArt,
      duration: s.duration,
    }));
    this.player.playWithContext(tracks, 0, { type: 'album', id: album.id, name: album.name });
  }

  toTrackFromSong(song: { id: string; title: string; artist: string; duration?: number; coverArt?: string }): Track {
    return toTrack(song, this.selectedAlbum()?.name);
  }

  private async fetchAlbums(): Promise<void> {
    this.loading.set(true);
    try {
      const data = await firstValueFrom(this.api.getAlbums('newest', 80));
      this.albums.set(data);
    } catch { /* ignore */ }
    finally { this.loading.set(false); }
  }
}
