import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ArtistLinksComponent } from '../../components/artist-links/artist-links.component';
import { CoverArtComponent } from '../../components/cover-art/cover-art.component';
import { EntityLinkComponent } from '../../components/entity-link/entity-link.component';
import { IconComponent } from '../../components/icon/icon.component';
import { SkeletonComponent } from '../../components/skeleton/skeleton.component';
import { OverflowRevealDirective } from '../../directives/overflow-reveal.directive';
import { albumLoadFailureFor } from '../../lib/album-load-state';
import { songCover } from '../../lib/cover-url';
import { offlineFind } from '../../lib/route-utils';
import { formatTime } from '../../lib/format-time';
import { toTrack } from '../../lib/track-utils';
import { TranslatePipe } from '../../pipes/translate.pipe';
import type { Song } from '../../services/api/api-types';
import { LibraryApiService } from '../../services/api/library-api.service';
import { AuthService } from '../../services/auth.service';
import { CoverRevisionsService } from '../../services/cover-revisions.service';
import { EntityMenuService } from '../../services/entity-menu.service';
import { OfflineModeService } from '../../services/offline-mode.service';
import { PlayerService } from '../../services/player.service';
import { SongMenuService } from '../../services/song-menu.service';

/** `not-found` is a 404 only; any other failure is `unavailable`, with a retry. */
type PageState = 'loading' | 'ready' | 'not-found' | 'unavailable';

/**
 * A song's own page (#2004), so a song can be linked to and shared. It shows
 * what identifies the song and offers Play, Start radio and the song's menu;
 * lyrics, credits and "more like this" are not here.
 */
@Component({
  selector: 'app-song-detail',
  imports: [
    ArtistLinksComponent,
    CoverArtComponent,
    EntityLinkComponent,
    IconComponent,
    OverflowRevealDirective,
    RouterLink,
    SkeletonComponent,
    TranslatePipe,
  ],
  templateUrl: './song-detail.component.html',
})
export class SongDetailComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(LibraryApiService);
  private readonly auth = inject(AuthService);
  private readonly coverRevisions = inject(CoverRevisionsService);
  private readonly player = inject(PlayerService);
  private readonly songMenu = inject(SongMenuService);
  private readonly entityMenu = inject(EntityMenuService);
  private readonly offline = inject(OfflineModeService);

  readonly state = signal<PageState>('loading');
  readonly song = signal<Song | null>(null);
  readonly coverSrc = computed(() => {
    const song = this.song();
    return song ? this.coverRevisions.url(songCover(song), 600, this.auth.mediaToken()) : undefined;
  });
  readonly duration = computed(() => {
    const seconds = this.song()?.duration;
    return seconds ? formatTime(seconds) : null;
  });

  private destroyed = false;

  constructor() {
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(() => (this.destroyed = true));
    this.route.paramMap
      .pipe(takeUntilDestroyed(destroyRef))
      .subscribe((params) => void this.load(params.get('id') ?? ''));
  }

  retry(): void {
    void this.load(this.route.snapshot.paramMap.get('id') ?? '');
  }

  private async load(id: string): Promise<void> {
    this.state.set('loading');
    this.song.set(null);
    let song: Song;
    try {
      song = await firstValueFrom(this.api.getSong(id));
    } catch (err) {
      // A late failure for a song the user left, or a page already gone, must
      // not redirect them or overwrite the page they are on.
      if (this.isStale(id)) return;
      if (this.offline.isOffline()) {
        // The page needs the server; offline, the saved songs are what there
        // is. Replace this entry, or Back would land here and bounce forward.
        const [commands, extras] = offlineFind('');
        void this.router.navigate(commands, { ...extras, replaceUrl: true });
        return;
      }
      this.state.set(albumLoadFailureFor(err) === 'missing' ? 'not-found' : 'unavailable');
      return;
    }
    if (this.isStale(id)) return;
    this.song.set(song);
    this.state.set('ready');
  }

  private isStale(id: string): boolean {
    return this.destroyed || this.route.snapshot.paramMap.get('id') !== id;
  }

  play(): void {
    const song = this.song();
    if (song) this.player.playSingle(toTrack(song));
  }

  startRadio(): void {
    const song = this.song();
    if (song) this.player.startRadio(toTrack(song));
  }

  openMenu(anchor: HTMLElement): void {
    const song = this.song();
    if (song) this.entityMenu.open({ actions: this.songMenu.build(song, {}), anchor });
  }
}
