import { Component, inject, signal, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { PlayerService } from '../../services/player.service';
import { PlaylistService } from '../../services/playlist.service';
import { AuthService } from '../../services/auth.service';
import { TrackRowComponent } from '../../components/track-row/track-row.component';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import { toTrack } from '../../lib/track-utils';
import { NavigationService } from '../../services/navigation.service';
import type { PlaylistDetail } from '../../services/api.service';

@Component({
  selector: 'app-playlist-detail',
  standalone: true,
  imports: [TrackRowComponent, ConfirmDialogComponent],
  templateUrl: './playlist-detail.component.html',
})
export class PlaylistDetailComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  readonly auth = inject(AuthService);
  readonly player = inject(PlayerService);
  private playlists = inject(PlaylistService);
  private nav = inject(NavigationService);

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
    this.player.playWithContext(tracks, index, { type: 'playlist', id: this.id, name: this.playlist()?.name });
  }

  playAll(): void {
    this.playFrom(0);
  }

  async removeSong(songId: string): Promise<void> {
    await this.playlists.removeSong(this.id, songId);
    this.playlist.update((p) => (p ? { ...p, songs: p.songs.filter((s) => s.id !== songId), songCount: p.songCount - 1 } : p));
  }

  async deletePlaylist(): Promise<void> {
    this.confirmingDelete.set(false);
    await this.playlists.delete(this.id);
    void this.router.navigate(['/library']);
  }

  toTrack = toTrack;
}
