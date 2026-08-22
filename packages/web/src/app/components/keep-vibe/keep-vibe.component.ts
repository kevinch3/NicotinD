import { Component, effect, inject, input, signal } from '@angular/core';
import { catchError, firstValueFrom, of } from 'rxjs';
import { AuthService } from '../../services/auth.service';
import { LibraryApiService } from '../../services/api/library-api.service';
import { PlayerService } from '../../services/player.service';
import { CoverArtComponent } from '../cover-art/cover-art.component';
import { SkeletonComponent } from '../skeleton/skeleton.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { toTrack } from '../../lib/track-utils';
import type { RecentPlay, Song } from '../../services/api/api-types';

/**
 * "Keep the vibe" shelf — variations on what the listener has been hearing.
 *
 * Takes the recently-played list as its `seeds` input (already loaded by
 * `RecentlyPlayedComponent` — no second history fetch) and asks the radio
 * engine for ONE list-seeded generation: the seeds' centroid picks the
 * recommendations, as if a radio had been started from that whole list
 * (`seedIds` lane on `/api/radio/next`). One request for the shelf, not one
 * radio per tile — the recent list is near-homogeneous in practice, so
 * per-seed radios would run N× the pool queries for near-identical picks.
 *
 * Same hide-when-empty rule as the recently-played shelf. Tapping a tile
 * starts a radio seeded from that recommendation, so the vibe keeps going
 * past the tapped track.
 */
@Component({
  selector: 'app-keep-vibe',
  standalone: true,
  imports: [CoverArtComponent, SkeletonComponent, TranslatePipe],
  template: `
    @if (loading()) {
      <section data-testid="keep-vibe-skeleton">
        <h2 class="text-lg font-bold text-theme-primary mb-3">{{ 'home.keepVibe' | t }}</h2>
        <app-skeleton variant="shelf-tile" [count]="6" [label]="'home.keepVibe' | t" />
      </section>
    } @else if (recs().length > 0) {
      <section data-testid="keep-vibe">
        <h2 class="text-lg font-bold text-theme-primary mb-3">{{ 'home.keepVibe' | t }}</h2>
        <div class="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1">
          @for (song of recs(); track song.id) {
            <button
              type="button"
              (click)="onPlay(song)"
              data-testid="keep-vibe-item"
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
export class KeepVibeComponent {
  private api = inject(LibraryApiService);
  private player = inject(PlayerService);
  private auth = inject(AuthService);

  /** The recently-played list this shelf riffs on. Empty → the shelf hides. */
  readonly seeds = input<RecentPlay[]>([]);

  readonly recs = signal<Song[]>([]);
  // Only ever true after seeds have arrived, so a fresh install (no history →
  // no seeds) never flashes a skeleton it is about to hide again — the same
  // rule `shouldShowRecentSkeleton` enforces for the shelf this one feeds on.
  readonly loading = signal(false);

  /** One generation per page visit: the seed list loads once, so re-running on
   *  every input tick would only churn the shelf under the user's finger. */
  private fetched = false;

  constructor() {
    // The seed list arrives asynchronously (the history fetch lives in
    // RecentlyPlayedComponent), so an effect over the input signal is what
    // fires again when the binding finally delivers it.
    effect(() => this.maybeGenerate(this.seeds()));
  }

  /** Visible for testing — the effect body (the JIT vitest harness can't
   *  deliver a second input write, see testing/signal-input.ts). */
  maybeGenerate(seeds: RecentPlay[]): void {
    if (this.fetched || seeds.length === 0) return;
    this.fetched = true;
    void this.load([...new Set(seeds.map((s) => s.songId))]);
  }

  /** Non-fatal: an unreachable radio endpoint just leaves the shelf hidden. */
  private async load(seedIds: string[]): Promise<void> {
    this.loading.set(true);
    try {
      const songs = await firstValueFrom(
        this.api.getListRadio(seedIds, 10).pipe(catchError(() => of([] as Song[]))),
      );
      this.recs.set(songs);
    } finally {
      this.loading.set(false);
    }
  }

  /** Start a radio seeded from the tapped recommendation — the vibe continues. */
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
