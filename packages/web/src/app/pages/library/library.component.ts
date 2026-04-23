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
  templateUrl: './library.component.html',
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
      const ids = (album.song ?? []).map(s => s.id);
      if (ids.length) {
        try { await firstValueFrom(this.api.deleteSongs(ids)); } catch { /* ignore */ }
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
      ...(this.auth.role() === 'admin' ? [{
        label: 'Remove',
        destructive: true,
        action: () => this.askConfirm(`Remove "${song.title}" from library?`, async () => {
          try { await firstValueFrom(this.api.deleteSongs([song.id])); } catch { /* ignore */ }
          this.selectedAlbum.update(a => a ? { ...a, song: a.song.filter(s => s.id !== song.id) } : null);
        }),
      }] : []),
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

  playGenre(): void {
    const genre = this.selectedGenre();
    const songs = this.genreSongs();
    if (!genre || !songs.length) return;
    const tracks = songs.map(s => toTrack(s));
    this.player.playWithContext(tracks, 0, { type: 'adhoc', name: genre });
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
      ...(this.auth.role() === 'admin' ? [{
        label: 'Remove',
        destructive: true,
        action: () => this.askConfirm(`Remove "${song.title}" from library?`, async () => {
          try { await firstValueFrom(this.api.deleteSongs([song.id])); } catch { /* ignore */ }
          this.genreSongs.update(s => s.filter(x => x.id !== song.id));
        }),
      }] : []),
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
