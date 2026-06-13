import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { PlayerService } from '../../services/player.service';
import { PlaylistService } from '../../services/playlist.service';
import { AuthService } from '../../services/auth.service';
import {
  TrackRowComponent,
  type TrackAction,
} from '../../components/track-row/track-row.component';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import { toTrack, offlineTrackAction, addToPlaylistAction } from '../../lib/track-utils';
import { createSelection } from '../../lib/selection';
import { SelectionBarComponent } from '../../components/selection-bar/selection-bar.component';
import { NavigationService } from '../../services/navigation.service';
import { PreserveService } from '../../services/preserve.service';
import type { PlaylistDetail } from '../../services/api.service';

@Component({
  selector: 'app-playlist-detail',
  standalone: true,
  imports: [TrackRowComponent, ConfirmDialogComponent, SelectionBarComponent],
  templateUrl: './playlist-detail.component.html',
})
export class PlaylistDetailComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  readonly auth = inject(AuthService);
  readonly player = inject(PlayerService);
  private playlists = inject(PlaylistService);
  private nav = inject(NavigationService);
  readonly preserve = inject(PreserveService);

  readonly loading = signal(true);
  readonly playlist = signal<PlaylistDetail | null>(null);
  readonly confirmingDelete = signal(false);

  private id = '';

  async ngOnInit(): Promise<void> {
    this.id = this.route.snapshot.paramMap.get('id') ?? '';
    await this.reload();
  }

  private async reload(): Promise<void> {
    this.loading.set(true);
    try {
      this.playlist.set(await this.playlists.get(this.id));
    } catch {
      this.playlist.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  goBack(): void {
    this.nav.back(['/library']);
  }

  playFrom(index: number): void {
    const songs = this.playlist()?.songs ?? [];
    if (!songs.length) return;
    const tracks = songs.map((s) => toTrack(s));
    this.player.playWithContext(tracks, index, {
      type: 'playlist',
      id: this.id,
      name: this.playlist()?.name,
    });
  }

  playAll(): void {
    this.playFrom(0);
  }

  async removeSong(songId: string): Promise<void> {
    await this.playlists.removeSong(this.id, songId);
    this.playlist.update((p) =>
      p ? { ...p, songs: p.songs.filter((s) => s.id !== songId), songCount: p.songCount - 1 } : p,
    );
  }

  // ─── Multi-select ─────────────────────────────────────────────────
  readonly selection = createSelection();

  selectAllSongs(): void {
    this.selection.selectAll((this.playlist()?.songs ?? []).map((s) => s.id));
  }

  addSelectedToPlaylist(): void {
    const ids = [...this.selection.ids()];
    if (ids.length === 0) return;
    this.playlists.openPicker(ids);
    this.selection.exit();
  }

  readonly playlistOrderedIds = computed(() => (this.playlist()?.songs ?? []).map((s) => s.id));

  async removeSelectedFromPlaylist(): Promise<void> {
    const ids = [...this.selection.ids()];
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    await Promise.all(ids.map((id) => this.playlists.removeSong(this.id, id)));
    this.playlist.update((p) =>
      p
        ? {
            ...p,
            songs: p.songs.filter((s) => !idSet.has(s.id)),
            songCount: p.songCount - ids.length,
          }
        : p,
    );
    this.selection.exit();
  }

  // ─── Offline download ─────────────────────────────────────────────
  readonly playlistTrackIds = computed(() => (this.playlist()?.songs ?? []).map((s) => s.id));
  readonly playlistDownloaded = computed(() =>
    this.preserve.isCollectionPreserved(this.playlistTrackIds()),
  );

  toggleDownload(): void {
    const pl = this.playlist();
    if (!pl?.songs?.length) return;
    if (this.playlistDownloaded()) {
      void this.preserve.removeMany(this.playlistTrackIds());
    } else {
      void this.preserve.preserveCollection(
        pl.id,
        pl.name,
        pl.songs.map((s) => toTrack(s)),
      );
    }
  }

  songActions(songId: string): TrackAction[] {
    const songs = this.playlist()?.songs ?? [];
    const song = songs.find((s) => s.id === songId);
    return song
      ? [
          offlineTrackAction(this.preserve, toTrack(song)),
          addToPlaylistAction(this.playlists, song.id),
        ]
      : [];
  }

  async deletePlaylist(): Promise<void> {
    this.confirmingDelete.set(false);
    await this.playlists.delete(this.id);
    void this.router.navigate(['/library']);
  }

  toTrack = toTrack;
}
