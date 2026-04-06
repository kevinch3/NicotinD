import { Component, inject, signal, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService, type Album } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { PlayerService } from '../../services/player.service';
import { toTrack } from '../../lib/track-utils';

@Component({
  selector: 'app-artist-detail',
  standalone: true,
  imports: [],
  template: `
    <div class="max-w-6xl mx-auto px-4 py-5 md:px-6 md:py-8">

      <!-- Back -->
      <button
        class="text-sm text-theme-muted hover:text-theme-secondary transition mb-6"
        (click)="router.navigate(['/library'])">
        &larr; Library
      </button>

      @if (loading()) {
        <div class="text-center py-20">
          <span class="inline-block w-5 h-5 border-2 border-theme border-t-zinc-300 rounded-full animate-spin"></span>
        </div>
      } @else if (artist()) {
        <!-- Artist header -->
        <div class="flex items-center gap-5 mb-8">
          <div class="w-20 h-20 rounded-full bg-theme-surface-2 flex items-center justify-center flex-shrink-0">
            <span class="text-3xl text-theme-muted font-medium">{{ artist()!.name.charAt(0).toUpperCase() }}</span>
          </div>
          <div>
            <h1 class="text-2xl font-bold text-theme-primary">{{ artist()!.name }}</h1>
            <p class="text-theme-muted text-sm mt-0.5">{{ albums().length }} album{{ albums().length !== 1 ? 's' : '' }}</p>
            @if (albums().length > 0) {
              <button (click)="playAll()" [disabled]="playingAll()"
                class="mt-3 px-5 py-2 rounded-lg bg-zinc-100 text-zinc-900 text-sm font-semibold hover:bg-zinc-200 transition disabled:opacity-50">
                {{ playingAll() ? 'Loading…' : 'Play All' }}
              </button>
            }
          </div>
        </div>

        <!-- Albums grid -->
        <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          @for (album of albums(); track album.id) {
            <button
              class="p-3 rounded-lg bg-theme-surface/30 hover:bg-theme-surface-2/50 transition text-left"
              (click)="openAlbum(album)">
              @if (album.coverArt) {
                <img [src]="'/api/cover/' + album.coverArt + '?size=300&token=' + auth.token()"
                  alt="" class="w-full aspect-square rounded object-cover mb-2" />
              } @else {
                <div class="w-full aspect-square rounded bg-theme-surface-2 mb-2"></div>
              }
              <p class="text-sm text-theme-primary truncate">{{ album.name }}</p>
              <p class="text-xs text-theme-muted">{{ album.year ?? '' }}</p>
            </button>
          }
        </div>

        @if (albums().length === 0) {
          <p class="text-center text-theme-muted py-20">No albums found for this artist.</p>
        }
      }
    </div>
  `,
})
export class ArtistDetailComponent implements OnInit {
  private route = inject(ActivatedRoute);
  readonly router = inject(Router);
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

  openAlbum(album: Album): void {
    this.router.navigate(['/library'], { queryParams: { album: album.id } });
  }
}
