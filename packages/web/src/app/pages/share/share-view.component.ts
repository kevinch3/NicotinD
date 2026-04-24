import {
  Component,
  inject,
  signal,
  computed,
  OnInit,
  OnDestroy,
  viewChild,
  ElementRef,
} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Meta, Title } from '@angular/platform-browser';
import { firstValueFrom } from 'rxjs';
import { ShareSessionService } from '../../services/share-session.service';

interface ShareTrack {
  id: string;
  title: string;
  artist: string;
  duration?: number;
  coverArt?: string;
  track?: number;
}

type PageState = 'loading' | 'active' | 'expired' | 'error';

@Component({
  selector: 'app-share-view',
  templateUrl: './share-view.component.html',
  imports: [],
})
export class ShareViewComponent implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private http = inject(HttpClient);
  private meta = inject(Meta);
  private titleService = inject(Title);
  private shareSession = inject(ShareSessionService);

  readonly audioRef = viewChild<ElementRef<HTMLAudioElement>>('audioEl');

  readonly state = signal<PageState>('loading');
  readonly resourceName = signal('');
  readonly resourceSubtitle = signal('');
  readonly coverArtId = signal<string | null>(null);
  readonly tracks = signal<ShareTrack[]>([]);
  readonly currentIndex = signal(0);
  readonly isPlaying = signal(false);
  readonly currentTime = signal(0);
  readonly audioDuration = signal(0);

  private shareToken = '';

  readonly currentTrack = computed(() => this.tracks()[this.currentIndex()] ?? null);

  readonly coverUrl = computed(() => {
    const id = this.coverArtId();
    const jwt = this.shareSession.shareJwt();
    return id && jwt ? `/api/cover/${id}?size=300&token=${jwt}` : null;
  });

  readonly streamUrl = computed(() => {
    const track = this.currentTrack();
    const jwt = this.shareSession.shareJwt();
    return track && jwt ? `/api/stream/${track.id}?token=${jwt}` : null;
  });

  async ngOnInit(): Promise<void> {
    this.shareToken = this.route.snapshot.paramMap.get('token') ?? '';
    try {
      const { jwt, resourceType, resourceId } = await this.shareSession.activate(this.shareToken);
      const headers = new HttpHeaders({ Authorization: `Bearer ${jwt}` });

      if (resourceType === 'album') {
        const album = await firstValueFrom(
          this.http.get<any>(`/api/library/albums/${resourceId}`, { headers }),
        );
        this.resourceName.set(album.name);
        this.resourceSubtitle.set(album.artist);
        this.coverArtId.set(album.coverArt ?? null);
        this.tracks.set(
          (album.song ?? []).map((s: any) => ({
            id: s.id,
            title: s.title,
            artist: s.artist,
            duration: s.duration,
            coverArt: s.coverArt,
            track: s.track,
          })),
        );
        this.setOgTags(album.name, album.artist, jwt, album.coverArt, 'music.album');
      } else {
        const pl = await firstValueFrom(
          this.http.get<any>(`/api/playlists/${resourceId}`, { headers }),
        );
        this.resourceName.set(pl.name);
        this.resourceSubtitle.set(`by ${pl.owner}`);
        this.coverArtId.set(pl.coverArt ?? null);
        this.tracks.set(
          (pl.entry ?? []).map((s: any) => ({
            id: s.id,
            title: s.title,
            artist: s.artist,
            duration: s.duration,
            coverArt: s.coverArt,
            track: s.track,
          })),
        );
        this.setOgTags(pl.name, `${pl.entry?.length ?? pl.songCount} tracks`, jwt, pl.coverArt, 'music.playlist');
      }
      this.state.set('active');
    } catch (err: any) {
      this.state.set(err?.status === 410 ? 'expired' : 'error');
    }
  }

  ngOnDestroy(): void {
    this.audioRef()?.nativeElement.pause();
  }

  playTrack(index: number): void {
    this.currentIndex.set(index);
    this.isPlaying.set(false);
    setTimeout(() => {
      const audio = this.audioRef()?.nativeElement;
      if (!audio) return;
      audio.src = this.streamUrl() ?? '';
      audio.load();
      void audio.play().then(() => this.isPlaying.set(true)).catch(() => {});
    }, 0);
  }

  togglePlay(): void {
    const audio = this.audioRef()?.nativeElement;
    if (!audio) return;
    if (this.isPlaying()) {
      audio.pause();
      this.isPlaying.set(false);
    } else {
      if (!audio.src) audio.src = this.streamUrl() ?? '';
      void audio.play().then(() => this.isPlaying.set(true)).catch(() => {});
    }
  }

  prevTrack(): void {
    const idx = this.currentIndex();
    if (idx > 0) this.playTrack(idx - 1);
  }

  nextTrack(): void {
    const idx = this.currentIndex();
    if (idx < this.tracks().length - 1) this.playTrack(idx + 1);
  }

  onTimeUpdate(event: Event): void {
    this.currentTime.set((event.target as HTMLAudioElement).currentTime);
  }

  onDurationChange(event: Event): void {
    this.audioDuration.set((event.target as HTMLAudioElement).duration);
  }

  onEnded(): void {
    this.isPlaying.set(false);
    this.nextTrack();
  }

  onSeek(event: Event): void {
    const audio = this.audioRef()?.nativeElement;
    if (!audio) return;
    audio.currentTime = Number((event.target as HTMLInputElement).value);
  }

  formatTime(seconds: number): string {
    if (!seconds || isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  private setOgTags(title: string, description: string, jwt: string, coverArtId: string | undefined, type: string): void {
    this.titleService.setTitle(`${title} — NicotinD`);
    this.meta.updateTag({ property: 'og:title', content: title });
    this.meta.updateTag({ property: 'og:description', content: description });
    this.meta.updateTag({ property: 'og:type', content: type });
    if (coverArtId) {
      this.meta.updateTag({ property: 'og:image', content: `/api/cover/${coverArtId}?token=${jwt}` });
    }
  }
}
