import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService, type Album, type DiscographyAlbum, type DiscographyResult } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { PlayerService } from '../../services/player.service';
import { AlbumHuntModalComponent } from '../../components/album-hunt-modal/album-hunt-modal.component';
import { CoverArtComponent } from '../../components/cover-art/cover-art.component';
import { toTrack } from '../../lib/track-utils';
import { resolveAlbumRoute } from '../../lib/route-utils';

@Component({
  selector: 'app-artist-detail',
  standalone: true,
  imports: [RouterLink, AlbumHuntModalComponent, CoverArtComponent],
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

  readonly discography = signal<DiscographyResult | null>(null);
  readonly discographyLoading = signal(false);
  readonly huntingAlbum = signal<DiscographyAlbum | null>(null);

  // Group the flat discography by release type for the template's sectioned grid.
  // Order: Albums → EPs → Singles → everything else; chronological within a group.
  private readonly typeOrder = ['Album', 'EP', 'Single'];
  readonly discographyGroups = computed<{ label: string; albums: DiscographyAlbum[] }[]>(() => {
    const disc = this.discography();
    if (!disc) return [];
    const buckets = new Map<string, DiscographyAlbum[]>();
    for (const album of disc.albums) {
      const key = album.albumType || 'Other';
      const bucket = buckets.get(key) ?? buckets.set(key, []).get(key)!;
      bucket.push(album);
    }
    const rank = (type: string): number => {
      const i = this.typeOrder.indexOf(type);
      return i === -1 ? this.typeOrder.length : i;
    };
    return [...buckets.entries()]
      .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
      .map(([label, albums]) => ({
        label,
        albums: [...albums].sort((x, y) => (x.releaseDate ?? '').localeCompare(y.releaseDate ?? '')),
      }));
  });

  async ngOnInit(): Promise<void> {
    const id = this.route.snapshot.paramMap.get('id') ?? '';
    try {
      const data = await firstValueFrom(this.api.getArtist(id));
      this.artist.set(data.artist);
      this.albums.set(data.albums);
    } catch { /* ignore */ }
    finally { this.loading.set(false); }

    // Load discography in background — gracefully absent if Lidarr not configured
    this.loadDiscography(id);
  }

  private async loadDiscography(artistId: string): Promise<void> {
    this.discographyLoading.set(true);
    try {
      const result = await firstValueFrom(this.api.getArtistDiscography(artistId));
      this.discography.set(result);
    } catch {
      // Lidarr not configured or artist not found — no discography shown
    } finally {
      this.discographyLoading.set(false);
    }
  }

  openHunt(album: DiscographyAlbum): void {
    this.huntingAlbum.set(album);
  }

  closeHunt(): void {
    this.huntingAlbum.set(null);
  }

  statusIcon(status: 'present' | 'partial' | 'missing'): string {
    if (status === 'present') return '✓';
    if (status === 'partial') return '◑';
    return '○';
  }

  statusClass(status: 'present' | 'partial' | 'missing'): string {
    if (status === 'present') return 'text-green-400';
    if (status === 'partial') return 'text-yellow-400';
    return 'text-zinc-500';
  }

  countByStatus(albums: DiscographyAlbum[], status: 'present' | 'partial' | 'missing'): number {
    return albums.filter((a) => a.status === status).length;
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
