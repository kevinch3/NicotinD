import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { Router, ActivatedRoute, RouterLink } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ApiService, type AlbumDetail, type Song } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { PlayerService, type Track } from '../../services/player.service';
import { TransferService } from '../../services/transfer.service';
import { ListControlsService, type SortOption } from '../../services/list-controls.service';
import { ListToolbarComponent } from '../../components/list-toolbar/list-toolbar.component';
import { TrackRowComponent, type TrackAction } from '../../components/track-row/track-row.component';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import { PlaylistAutocompleteComponent } from '../../components/playlist-autocomplete/playlist-autocomplete.component';
import { toTrack } from '../../lib/track-utils';
import { resolveArtistRoute } from '../../lib/route-utils';

@Component({
  selector: 'app-album-detail',
  imports: [ListToolbarComponent, TrackRowComponent, ConfirmDialogComponent, PlaylistAutocompleteComponent, RouterLink],
  templateUrl: './album-detail.component.html',
})
export class AlbumDetailComponent implements OnInit {
  private api = inject(ApiService);
  readonly auth = inject(AuthService);
  readonly player = inject(PlayerService);
  private transferService = inject(TransferService);
  private listControls = inject(ListControlsService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private http = inject(HttpClient);
  readonly shareCopied = signal(false);

  readonly loadingAlbum = signal(true);
  readonly selectedAlbum = signal<AlbumDetail | null>(null);

  readonly detailSongs = computed(() => {
    const deleted = this.transferService.deletedSongIds();
    return (this.selectedAlbum()?.song ?? []).filter(s => !deleted.has(s.id));
  });

  readonly detailSortOptions: SortOption[] = [
    { field: 'track', label: 'Track #' },
    { field: 'title', label: 'Title' },
    { field: 'artist', label: 'Artist' },
  ];

  readonly detailControls = this.listControls.connect({
    pageKey: 'library-album',
    items: this.detailSongs,
    searchFields: ['title', 'artist'] as const,
    sortOptions: this.detailSortOptions,
    defaultSort: 'track',
  });

  // ─── Playlist picker ──────────────────────────────────────────────
  readonly playlistPickerSong = signal<{ id: string; title: string } | null>(null);
  readonly addingToPlaylistLib = signal(false);

  async addSongToPlaylist(playlistId: string): Promise<void> {
    const song = this.playlistPickerSong();
    if (!song) return;
    this.addingToPlaylistLib.set(true);
    try {
      await firstValueFrom(this.api.updatePlaylist(playlistId, { songIdsToAdd: [song.id] }));
      this.playlistPickerSong.set(null);
    } catch { /* ignore */ }
    finally { this.addingToPlaylistLib.set(false); }
  }

  async createLibraryPlaylistAndAdd(name: string): Promise<void> {
    const song = this.playlistPickerSong();
    if (!song) return;
    this.addingToPlaylistLib.set(true);
    try {
      await firstValueFrom(this.api.createPlaylist(name, [song.id]));
      this.playlistPickerSong.set(null);
    } catch { /* ignore */ }
    finally { this.addingToPlaylistLib.set(false); }
  }

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
  async ngOnInit(): Promise<void> {
    const albumId = this.route.snapshot.paramMap.get('id');
    if (albumId) {
      try {
        const detail = await firstValueFrom(this.api.getAlbum(albumId));
        this.selectedAlbum.set(detail);
      } catch { /* ignore */ }
      finally {
        this.loadingAlbum.set(false);
      }
    } else {
      this.loadingAlbum.set(false);
    }
  }

  // ─── Albums methods ───────────────────────────────────────────────
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

  toTrackFromSong(song: { id: string; title: string; artist: string; duration?: number; coverArt?: string; bitRate?: number }): Track {
    return toTrack(song, this.selectedAlbum()?.name);
  }

  removeAlbum(): void {
    const album = this.selectedAlbum();
    if (!album) return;
    this.askConfirm(`Remove all tracks in "${album.name}"?`, async () => {
      const ids = (album.song ?? []).map(s => s.id);
      if (ids.length) {
        try { await firstValueFrom(this.api.deleteSongs(ids)); } catch { /* ignore */ }
        this.transferService.addDeletedIds(ids);
      }
      this.selectedAlbum.set(null);
      void this.router.navigate(['/library']);
    });
  }

  getArtistLink(id: string | undefined): string[] {
    return resolveArtistRoute(id);
  }

  albumTrackActions(song: { id: string; title: string; artistId?: string }): TrackAction[] {
    return [
      { label: 'Add to playlist', action: () => this.playlistPickerSong.set(song) },
      ...(song.artistId ? [{
        label: 'Go to artist',
        action: () => {
          void this.router.navigate(resolveArtistRoute(song.artistId));
        },
      }] : []),
      ...(this.auth.role() === 'admin' ? [{
        label: 'Remove',
        destructive: true,
        action: () => this.askConfirm(`Remove "${song.title}" from library?`, async () => {
          try { await firstValueFrom(this.api.deleteSongs([song.id])); } catch { /* ignore */ }
          this.transferService.addDeletedIds([song.id]);
          this.selectedAlbum.update(a => a ? { ...a, song: a.song.filter(s => s.id !== song.id) } : null);
        }),
      }] : []),
    ];
  }

  shareAlbum(): void {
    const album = this.selectedAlbum();
    if (!album) return;
    this.http.post<{ url: string }>('/api/share', { resourceType: 'album', resourceId: album.id }).subscribe({
      next: ({ url }) => {
        navigator.clipboard.writeText(url).catch(() => {});
        this.shareCopied.set(true);
        setTimeout(() => this.shareCopied.set(false), 3000);
      },
    });
  }
}
