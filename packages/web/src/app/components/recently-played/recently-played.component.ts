import { Component, OnInit, inject, signal } from '@angular/core';
import { catchError, firstValueFrom, of } from 'rxjs';
import { AuthService } from '../../services/auth.service';
import { HistoryApiService } from '../../services/api/history-api.service';
import { PlayerService, type Track } from '../../services/player.service';
import { CoverArtComponent } from '../cover-art/cover-art.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import type { RecentPlay } from '../../services/api/api-types';

/**
 * "Recently played" shelf — the first read surface over the listening log.
 *
 * Hides itself entirely when there is nothing to show, which is the normal
 * state on a fresh install and for the first few plays. A shelf that renders an
 * empty box on the landing screen would be worse than no shelf.
 *
 * Tapping a tile plays that list as the queue (`playWithContext`), not the bare
 * primitive — a context-less click is exactly the bug #233 fixed, where a
 * standalone play left an unrelated queue in place to resume afterwards.
 *
 * See docs/listening-history.md.
 */
@Component({
  selector: 'app-recently-played',
  standalone: true,
  imports: [CoverArtComponent, TranslatePipe],
  template: `
    @if (plays().length > 0) {
      <section data-testid="recently-played">
        <h2 class="text-lg font-bold text-theme-primary mb-3">{{ 'home.recentlyPlayed' | t }}</h2>
        <div class="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1">
          @for (play of plays(); track play.songId; let i = $index) {
            <button
              type="button"
              (click)="onPlay(i)"
              data-testid="recently-played-item"
              [attr.data-song-id]="play.songId"
              class="shrink-0 w-28 text-left group active:scale-95 transition"
            >
              <app-cover-art
                [src]="coverSrc(play)"
                [artist]="play.artist ?? ''"
                [album]="play.album ?? ''"
                [size]="112"
                className="w-28 h-28"
                rounded="rounded-lg"
              />
              <p class="mt-1.5 text-xs font-semibold text-theme-primary truncate">
                {{ play.title }}
              </p>
              <p class="text-xs text-theme-muted truncate">{{ play.artist }}</p>
            </button>
          }
        </div>
      </section>
    }
  `,
})
export class RecentlyPlayedComponent implements OnInit {
  private api = inject(HistoryApiService);
  private player = inject(PlayerService);
  private auth = inject(AuthService);

  readonly plays = signal<RecentPlay[]>([]);

  ngOnInit(): void {
    void this.load();
  }

  /** Non-fatal: an unreachable history endpoint just leaves the shelf hidden. */
  private async load(): Promise<void> {
    const rows = await firstValueFrom(
      this.api.getRecentPlays(20).pipe(catchError(() => of([] as RecentPlay[]))),
    );
    this.plays.set(rows);
  }

  onPlay(index: number): void {
    const tracks = this.plays().map(toTrack);
    if (tracks.length === 0) return;
    this.player.playWithContext(tracks, index, { type: 'adhoc', name: 'Recently played' });
  }

  /**
   * `coverArt` is a cover *id*, never a URL — build the standard
   * `/api/cover/:id?size=&token=` URL like every other cover call site (passing
   * the bare id as an <img src> 404s into the letter placeholder).
   */
  coverSrc(play: RecentPlay): string | undefined {
    return play.coverArt
      ? `/api/cover/${play.coverArt}?size=300&token=${this.auth.token()}`
      : undefined;
  }
}

/** A recent play is already a live library song — enough to build a Track. */
function toTrack(play: RecentPlay): Track {
  return {
    id: play.songId,
    title: play.title ?? '',
    artist: play.artist ?? '',
    album: play.album ?? undefined,
    coverArt: play.coverArt ?? undefined,
    duration: play.duration ?? undefined,
  };
}
