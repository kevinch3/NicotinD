import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { catchError, firstValueFrom, of } from 'rxjs';
import { AuthService } from '../../services/auth.service';
import { LibraryApiService } from '../../services/api/library-api.service';
import { PlayerService } from '../../services/player.service';
import { CoverArtComponent } from '../cover-art/cover-art.component';
import { SkeletonComponent } from '../skeleton/skeleton.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { toTrack } from '../../lib/track-utils';
import type { RecentPlay, Song } from '../../services/api/api-types';

/** Over-fetch factor: the pool is re-ordered unheard-first and then cut to
 *  SHELF_SIZE, so it must be deep enough for the demotion to have somewhere to
 *  push recent plays to. */
const POOL_SIZE = 24;
const SHELF_SIZE = 10;

/**
 * "Taste breakers" shelf — a uniformly random slice of the library, ordered so
 * what the listener has just been hearing sinks to the back. The counterweight
 * to "Keep the vibe": that shelf converges on the current mood, this one
 * deliberately does not.
 *
 * Unlike Keep the vibe, this shelf does NOT gate its fetch on `seeds`. Random
 * songs exist on a fresh install with no listening history at all, and gating
 * would leave that install staring at a permanently hidden shelf. Instead the
 * pool is fetched once on init and the rendered slice is a `computed()` over
 * the live `seeds` signal — so the shelf paints immediately, then quietly
 * re-orders when the history arrives, with no second request.
 *
 * Tapping a tile starts a radio seeded from that track, so an unfamiliar song
 * becomes a whole direction rather than a single orphan play.
 */
@Component({
  selector: 'app-taste-breakers',
  standalone: true,
  imports: [CoverArtComponent, SkeletonComponent, TranslatePipe],
  template: `
    @if (loading()) {
      <section data-testid="taste-breakers-skeleton">
        <h2 class="text-lg font-bold text-theme-primary mb-3">{{ 'home.tasteBreakers' | t }}</h2>
        <app-skeleton variant="shelf-tile" [count]="6" [label]="'home.tasteBreakers' | t" />
      </section>
    } @else if (picks().length > 0) {
      <section data-testid="taste-breakers">
        <h2 class="text-lg font-bold text-theme-primary mb-1">{{ 'home.tasteBreakers' | t }}</h2>
        <p class="text-sm text-theme-muted mb-3">{{ 'home.tasteBreakersHint' | t }}</p>
        <div class="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1">
          @for (song of picks(); track song.id) {
            <button
              type="button"
              (click)="onPlay(song)"
              data-testid="taste-breakers-item"
              [attr.data-song-id]="song.id"
              class="shrink-0 w-28 text-left group active:scale-95 transition"
            >
              <app-cover-art
                [src]="coverSrc(song)"
                [artist]="song.artist"
                [album]="song.album"
                [size]="112"
                className="w-28 h-28"
                rounded="rounded-lg"
              />
              <p class="mt-1.5 text-xs font-semibold text-theme-primary truncate">
                {{ song.title }}
              </p>
              <p class="text-xs text-theme-muted truncate">{{ song.artist }}</p>
            </button>
          }
        </div>
      </section>
    }
  `,
})
export class TasteBreakersComponent implements OnInit {
  private api = inject(LibraryApiService);
  private player = inject(PlayerService);
  private auth = inject(AuthService);

  /** Recently-played rows to steer away from. Read live, never awaited. */
  readonly seeds = input<RecentPlay[]>([]);

  /** The raw random pool, fetched once. */
  readonly pool = signal<Song[]>([]);
  readonly loading = signal(false);

  /**
   * The pool ordered unheard-first, capped at the shelf size.
   *
   * A **demotion, never an exclusion** — the same rule the genre stations
   * follow. A hard filter reads fine against a big library, but a small one can
   * have every random pick sitting in the last 20 plays, and the shelf would
   * silently vanish exactly for the listener with the least to explore. So
   * recent plays sink to the back and only fall off the end.
   */
  readonly picks = computed(() => {
    const recent = new Set(this.seeds().map((s) => s.songId));
    const pool = this.pool();
    return [
      ...pool.filter((s) => !recent.has(s.id)),
      ...pool.filter((s) => recent.has(s.id)),
    ].slice(0, SHELF_SIZE);
  });

  ngOnInit(): void {
    void this.load();
  }

  /** Non-fatal: an unreachable library endpoint just leaves the shelf hidden. */
  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      const songs = await firstValueFrom(
        this.api.getRandomSongs(POOL_SIZE).pipe(catchError(() => of([] as Song[]))),
      );
      this.pool.set(songs);
    } finally {
      this.loading.set(false);
    }
  }

  /** Start a radio seeded from the tapped track — the detour becomes a direction. */
  onPlay(song: Song): void {
    this.player.startRadio(toTrack(song));
  }

  /**
   * `coverArt` is a cover *id*, never a URL — build the standard
   * `/api/cover/:id?size=&token=` URL like every other cover call site.
   */
  coverSrc(song: Song): string | undefined {
    return song.coverArt
      ? `/api/cover/${song.coverArt}?size=300&token=${this.auth.token()}`
      : undefined;
  }
}
