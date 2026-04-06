import { Component, inject, signal, computed, effect, OnInit } from '@angular/core';
import { Router, RouterLink, ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService, type Album, type AlbumDetail, type Song } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { PlayerService, type Track } from '../../services/player.service';
import { TransferService } from '../../services/transfer.service';
import { ListControlsService, type SortOption } from '../../services/list-controls.service';
import { ListToolbarComponent } from '../../components/list-toolbar/list-toolbar.component';
import { TrackRowComponent, type TrackAction } from '../../components/track-row/track-row.component';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import { toTrack } from '../../lib/track-utils';

type LibraryMode = 'albums' | 'artists' | 'genre';

@Component({
  selector: 'app-library',
  imports: [ListToolbarComponent, TrackRowComponent, ConfirmDialogComponent, RouterLink],
  template: `
    <div class="max-w-6xl mx-auto px-4 py-5 md:px-6 md:py-8">

      <!-- Mode switcher -->
      @if (!selectedAlbum() && !selectedGenre()) {
        <div class="flex items-center justify-between mb-6">
          <div class="flex gap-1 p-1 bg-theme-surface-2 rounded-xl">
            @for (m of modes; track m.value) {
              <button
                class="px-4 py-1.5 text-sm rounded-lg transition-colors"
                [class.bg-theme-surface]="libraryMode() === m.value"
                [class.text-theme-primary]="libraryMode() === m.value"
                [class.text-theme-muted]="libraryMode() !== m.value"
                (click)="setMode(m.value)">
                {{ m.label }}
              </button>
            }
          </div>
        </div>
      }

      <!-- ═══ ALBUMS MODE ═══ -->
      @if (libraryMode() === 'albums') {
        @if (selectedAlbum()) {
          <!-- Album detail view -->
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
              @if (selectedAlbum()!.artistId) {
                <a [routerLink]="['/library', 'artists', selectedAlbum()!.artistId]"
                  class="text-theme-secondary hover:text-theme-primary transition mt-1 cursor-pointer">
                  {{ selectedAlbum()!.artist }}
                </a>
              } @else {
                <p class="text-theme-secondary mt-1">{{ selectedAlbum()!.artist }}</p>
              }
              @if (selectedAlbum()!.year) {
                <p class="text-theme-muted text-sm mt-1">{{ selectedAlbum()!.year }}</p>
              }
              <div class="flex justify-center sm:justify-start gap-3 mt-4">
                <button (click)="playAlbum()"
                  class="px-5 py-2 rounded-lg bg-zinc-100 text-zinc-900 text-sm font-semibold hover:bg-zinc-200 transition">
                  Play Album
                </button>
                <button (click)="removeAlbum()"
                  class="px-4 py-2 rounded-lg text-sm text-red-400 hover:bg-red-500/10 transition">
                  Remove album
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
                [actions]="albumTrackActions(song)"
                (play)="playSong(song)"
              />
            }
          </div>
        } @else {
          <!-- Album grid -->
          <div class="flex items-center gap-3 mb-4">
            <button (click)="gridControls.showToolbar()" class="p-1 text-theme-muted hover:text-theme-secondary transition" title="Search">
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
            <p class="text-center text-theme-muted py-20">No albums yet. Download some music to get started!</p>
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
        }
      }

      <!-- ═══ ARTISTS MODE ═══ -->
      @if (libraryMode() === 'artists') {
        <div class="flex items-center gap-3 mb-4">
          <button (click)="artistControls.showToolbar()"
            class="p-1 text-theme-muted hover:text-theme-secondary transition" title="Search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          </button>
        </div>
        @if (artistControls.isToolbarVisible()) {
          <app-list-toolbar
            [searchText]="artistControls.searchText()"
            [sortField]="artistControls.sortField()"
            [sortDirection]="artistControls.sortDirection()"
            [sortOptions]="artistSortOptions"
            [resultCount]="artistControls.filtered().length"
            (searchChange)="artistControls.setSearchText($event)"
            (sortFieldChange)="artistControls.setSortField($event)"
            (toggleDirection)="artistControls.toggleSortDirection()"
            (dismiss)="artistControls.hideToolbar()"
          />
        }

        @if (loadingArtists()) {
          <div class="text-center py-20">
            <span class="inline-block w-5 h-5 border-2 border-theme border-t-zinc-300 rounded-full animate-spin"></span>
          </div>
        } @else {
          <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            @for (artist of artistControls.filtered(); track artist.id) {
              <a [routerLink]="['/library', 'artists', artist.id]"
                class="flex flex-col items-center gap-2 p-3 rounded-xl hover:bg-theme-hover transition-colors text-center cursor-pointer">
                <div class="w-20 h-20 rounded-full bg-theme-surface-2 flex items-center justify-center">
                  <span class="text-2xl text-theme-muted font-medium">{{ artist.name.charAt(0).toUpperCase() }}</span>
                </div>
                <div class="min-w-0 w-full">
                  <div class="text-sm text-theme-primary truncate">{{ artist.name }}</div>
                  <div class="text-xs text-theme-muted">{{ artist.albumCount }} album{{ artist.albumCount !== 1 ? 's' : '' }}</div>
                </div>
              </a>
            }
          </div>
          @if (artistControls.filtered().length === 0 && !loadingArtists()) {
            <p class="text-center text-theme-muted py-20">No artists found.</p>
          }
        }
      }

      <!-- ═══ GENRE MODE ═══ -->
      @if (libraryMode() === 'genre') {
        @if (selectedGenre()) {
          <!-- Genre track list -->
          <div class="flex items-center gap-3 mb-6">
            <button class="text-sm text-theme-muted hover:text-theme-secondary transition" (click)="selectedGenre.set(null)">
              &larr; Back
            </button>
            <h2 class="text-lg font-semibold text-theme-primary">{{ selectedGenre() }}</h2>
          </div>
          @if (loadingGenreSongs()) {
            <div class="text-center py-20">
              <span class="inline-block w-5 h-5 border-2 border-theme border-t-zinc-300 rounded-full animate-spin"></span>
            </div>
          } @else {
            @for (song of genreSongs(); track song.id) {
              <app-track-row
                [track]="toTrackFn(song)"
                [subtitle]="song.artist + ' · ' + song.album"
                [duration]="song.duration"
                [actions]="genreTrackActions(song)"
                (play)="player.play(toTrackFn(song))"
              />
            }
          }
        } @else {
          <!-- Genre grid -->
          @if (loadingGenres()) {
            <div class="text-center py-20">
              <span class="inline-block w-5 h-5 border-2 border-theme border-t-zinc-300 rounded-full animate-spin"></span>
            </div>
          } @else {
            <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              @for (genre of genres(); track genre.value) {
                <button
                  class="flex flex-col items-start gap-1 p-4 rounded-xl bg-theme-surface hover:bg-theme-hover transition-colors border border-theme text-left"
                  (click)="openGenre(genre.value)">
                  <div class="text-sm text-theme-primary font-medium truncate w-full">{{ genre.value }}</div>
                  <div class="text-xs text-theme-muted">{{ genre.songCount }} tracks</div>
                </button>
              }
            </div>
            @if (genres().length === 0) {
              <p class="text-center text-theme-muted py-20">No genres found.</p>
            }
          }
        }
      }

      <!-- Confirm dialog -->
      @if (showConfirm()) {
        <app-confirm-dialog
          [message]="confirmMessage()"
          confirmLabel="Remove"
          (confirm)="onConfirm()"
          (cancel)="onCancelConfirm()"
        />
      }
    </div>
  `,
})
export class LibraryComponent implements OnInit {
  private api = inject(ApiService);
  readonly auth = inject(AuthService);
  readonly player = inject(PlayerService);
  private transferService = inject(TransferService);
  private listControls = inject(ListControlsService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

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
  readonly selectedAlbum = signal<AlbumDetail | null>(null);
  readonly loadingAlbum = signal(false);

  readonly detailSongs = computed(() => this.selectedAlbum()?.song ?? []);

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
  readonly selectedGenre = signal<string | null>(null);
  readonly genreSongs = signal<Song[]>([]);
  readonly loadingGenreSongs = signal(false);

  // ─── Confirm dialog ───────────────────────────────────────────────
  readonly confirmMessage = signal('');
  readonly confirmCallback = signal<(() => void | Promise<void>) | null>(null);
  readonly showConfirm = computed(() => this.confirmCallback() !== null);

  private askConfirm(message: string, cb: () => void | Promise<void>): void {
    this.confirmMessage.set(message);
    this.confirmCallback.set(cb);
  }

  onConfirm(): void {
    const cb = this.confirmCallback();
    this.confirmCallback.set(null);
    Promise.resolve(cb?.()).catch(() => { /* ignore */ });
  }

  onCancelConfirm(): void {
    this.confirmCallback.set(null);
  }

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
    // Auto-open album from query param (e.g. navigated from ArtistDetailComponent)
    const albumId = this.route.snapshot.queryParamMap.get('album');
    if (albumId) {
      this.libraryMode.set('albums');
      try {
        const detail = await firstValueFrom(this.api.getAlbum(albumId));
        this.selectedAlbum.set(detail);
      } catch { /* ignore */ }
    }
  }

  // ─── Albums methods ───────────────────────────────────────────────
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
      id: s.id, title: s.title, artist: s.artist,
      album: album.name, coverArt: s.coverArt, duration: s.duration,
    }));
    this.player.playWithContext(tracks, 0, { type: 'album', id: album.id, name: album.name });
  }

  toTrackFromSong(song: { id: string; title: string; artist: string; duration?: number; coverArt?: string }): Track {
    return toTrack(song, this.selectedAlbum()?.name);
  }

  protected toTrackFn = toTrack;

  removeAlbum(): void {
    const album = this.selectedAlbum();
    if (!album) return;
    this.askConfirm(`Remove all tracks in "${album.name}"?`, async () => {
      for (const song of album.song ?? []) {
        try { await firstValueFrom(this.api.deleteSong(song.id)); } catch { /* ignore */ }
      }
      this.selectedAlbum.set(null);
      this.fetchAlbums();
    });
  }

  albumTrackActions(song: { id: string; title: string; artistId?: string }): TrackAction[] {
    return [
      ...(song.artistId ? [{
        label: 'Go to artist',
        action: () => {
          void this.router.navigate(['/library', 'artists', song.artistId]);
        },
      }] : []),
      {
        label: 'Remove',
        destructive: true,
        action: () => this.askConfirm(`Remove "${song.title}" from library?`, async () => {
          try { await firstValueFrom(this.api.deleteSong(song.id)); } catch { /* ignore */ }
          this.selectedAlbum.update(a => a ? { ...a, song: a.song.filter(s => s.id !== song.id) } : null);
        }),
      },
    ];
  }

  // ─── Artists methods ──────────────────────────────────────────────
  async fetchArtists(): Promise<void> {
    if (this.loadingArtists()) return;
    this.loadingArtists.set(true);
    try {
      const data = await firstValueFrom(this.api.getArtists());
      this.artists.set(data.map(a => ({ ...a, albumCount: a.albumCount ?? 0 })));
    } catch { /* ignore */ }
    finally { this.loadingArtists.set(false); }
  }

  // ─── Genre methods ────────────────────────────────────────────────
  async fetchGenres(): Promise<void> {
    if (this.loadingGenres()) return;
    this.loadingGenres.set(true);
    try {
      const data = await firstValueFrom(this.api.getGenres());
      this.genres.set(data.sort((a, b) => b.songCount - a.songCount));
    } catch { /* ignore */ }
    finally { this.loadingGenres.set(false); }
  }

  async openGenre(genre: string): Promise<void> {
    this.selectedGenre.set(genre);
    this.loadingGenreSongs.set(true);
    try {
      const songs = await firstValueFrom(this.api.getSongsByGenre(genre));
      this.genreSongs.set(songs);
    } catch { /* ignore */ }
    finally { this.loadingGenreSongs.set(false); }
  }

  genreTrackActions(song: Song): TrackAction[] {
    return [
      ...(song.artistId ? [{
        label: 'Go to artist',
        action: () => { void this.router.navigate(['/library', 'artists', song.artistId]); },
      }] : []),
      {
        label: 'Remove',
        destructive: true,
        action: () => this.askConfirm(`Remove "${song.title}" from library?`, async () => {
          try { await firstValueFrom(this.api.deleteSong(song.id)); } catch { /* ignore */ }
          this.genreSongs.update(s => s.filter(x => x.id !== song.id));
        }),
      },
    ];
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
