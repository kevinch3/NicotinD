import { Component, inject, signal, OnInit } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService, type Album } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { PlayerService } from '../../services/player.service';
import { toTrack } from '../../lib/track-utils';
import { resolveAlbumRoute } from '../../lib/route-utils';

@Component({
  selector: 'app-artist-detail',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './artist-detail.component.html',
  })
export class ArtistDetailComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private api = inject(ApiService);
  readonly auth = inject(AuthService);
  private player = inject(PlayerService);

  readonly loading = signal(true);
  readonly playingAll = signal(false);
  readonly artist = signal<{ id: string; name: string; albumCount: number; coverArt?: string } | null>(null);
  readonly albums = signal<Album[]>([]);

  async ngOnInit(): Promise<void> {
    const id = this.route.snapshot.paramMap.get('id') ?? '';
    try {
      const data = await firstValueFrom(this.api.getArtist(id));
      this.artist.set(data.artist);
      this.albums.set(data.albums);
    } catch { /* ignore */ }
    finally { this.loading.set(false); }
  }

  async playAll(): Promise<void> {
    const artistName = this.artist()?.name;
    const albums = this.albums();
    if (!albums.length) return;
    this.playingAll.set(true);
    try {
      const details = await Promise.all(albums.map(a => firstValueFrom(this.api.getAlbum(a.id))));
      const tracks = details.flatMap(detail =>
        detail.song.map(s => toTrack(s, detail.name)),
      );
      if (tracks.length) {
        this.player.playWithContext(tracks, 0, { type: 'adhoc', name: artistName });
      }
    } catch { /* ignore */ }
    finally { this.playingAll.set(false); }
  }

  getAlbumLink(id: string) {
    return resolveAlbumRoute(id);
  }
}
