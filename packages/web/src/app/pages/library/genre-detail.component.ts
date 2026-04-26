import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { Router, ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService, type Song } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { PlayerService, type Track } from '../../services/player.service';
import { TransferService } from '../../services/transfer.service';
import { TrackRowComponent, type TrackAction } from '../../components/track-row/track-row.component';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import { PlaylistAutocompleteComponent } from '../../components/playlist-autocomplete/playlist-autocomplete.component';
import { toTrack } from '../../lib/track-utils';
import { resolveArtistRoute } from '../../lib/route-utils';

@Component({
  selector: 'app-genre-detail',
  imports: [TrackRowComponent, ConfirmDialogComponent, PlaylistAutocompleteComponent, RouterLink],
  templateUrl: './genre-detail.component.html',
})
export class GenreDetailComponent implements OnInit {
  private api = inject(ApiService);
  readonly auth = inject(AuthService);
  readonly player = inject(PlayerService);
  private transferService = inject(TransferService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  readonly loadingGenreSongs = signal(true);
  readonly genreSlug = signal<string | null>(null);
  readonly genreSongs = signal<Song[]>([]);

  readonly filteredGenreSongs = computed(() => {
    const deleted = this.transferService.deletedSongIds();
    return this.genreSongs().filter(s => !deleted.has(s.id));
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
    const slug = this.route.snapshot.paramMap.get('slug');
    if (slug) {
      this.genreSlug.set(slug);
      try {
        const songs = await firstValueFrom(this.api.getSongsByGenre(slug));
        this.genreSongs.set(songs);
      } catch { /* ignore */ }
      finally {
        this.loadingGenreSongs.set(false);
      }
    } else {
       this.loadingGenreSongs.set(false);
    }
  }

  // ─── Genre methods ────────────────────────────────────────────────
  playGenre(): void {
    const genre = this.genreSlug();
    const songs = this.genreSongs();
    if (!genre || !songs.length) return;
    const tracks = songs.map(s => toTrack(s));
    this.player.playWithContext(tracks, 0, { type: 'adhoc', name: genre });
  }

  protected toTrackFn = toTrack;

  genreTrackActions(song: Song): TrackAction[] {
    return [
      { label: 'Add to playlist', action: () => this.playlistPickerSong.set(song) },
      ...(song.artistId ? [{
        label: 'Go to artist',
        action: () => { void this.router.navigate(resolveArtistRoute(song.artistId)); },
      }] : []),
      ...(this.auth.role() === 'admin' ? [{
        label: 'Remove',
        destructive: true,
        action: () => this.askConfirm(`Remove "${song.title}" from library?`, async () => {
          try { await firstValueFrom(this.api.deleteSongs([song.id])); } catch { /* ignore */ }
          this.transferService.addDeletedIds([song.id]);
          this.genreSongs.update(s => s.filter(x => x.id !== song.id));
        }),
      }] : []),
    ];
  }
}
