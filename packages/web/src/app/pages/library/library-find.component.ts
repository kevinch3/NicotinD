import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { SearchApiService } from '../../services/api/search-api.service';
import { AuthService } from '../../services/auth.service';
import { PlayerService } from '../../services/player.service';
import { PullToRefreshService } from '../../services/pull-to-refresh.service';
import { SongMenuService } from '../../services/song-menu.service';
import { CoverArtComponent } from '../../components/cover-art/cover-art.component';
import { TrackRowComponent } from '../../components/track-row/track-row.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { toTrack } from '../../lib/track-utils';
import type { SearchResult } from '../../services/api/api-types';

type LocalResults = SearchResult['local'];

const EMPTY: LocalResults = { artists: [], albums: [], songs: [] };

// ─── Component ──────────────────────────────────────────────────────
// Cross-type "find what I own": one query, results grouped Albums / Artists /
// Songs. Deliberately NOT a per-tab filter — feedback-log-2026-07 item #7 was a
// user whose album existed and whose tracks existed, but who was looking at the
// wrong result type and concluded the release was missing. A filter scoped to
// the active tab reproduces that failure by construction.
//
// Lives outside library.component (already 759 lines / 7 tabs) and does no
// matching of its own: /api/search's local lane already tokenizes, folds
// diacritics, ANDs per token over a name+artist haystack, and excludes
// quarantined rows. Playlists are not in that lane, so they're out of scope.
@Component({
  selector: 'app-library-find',
  imports: [RouterLink, CoverArtComponent, TrackRowComponent, TranslatePipe],
  templateUrl: './library-find.component.html',
})
export class LibraryFindComponent {
  private readonly api = inject(SearchApiService);
  private readonly player = inject(PlayerService);
  private readonly p2r = inject(PullToRefreshService);
  readonly auth = inject(AuthService);
  readonly songMenu = inject(SongMenuService);

  /** Already debounced by the host — every change here is a real request.
   *  Defaults to empty (which searches nothing) rather than being required, so
   *  the component is inert until a query actually arrives. */
  readonly query = input('');

  readonly loading = signal(false);
  readonly results = signal<LocalResults>(EMPTY);
  readonly failed = signal(false);

  readonly isEmpty = computed(() => {
    const r = this.results();
    return r.albums.length === 0 && r.artists.length === 0 && r.songs.length === 0;
  });

  constructor() {
    effect(() => void this.run(this.query()));
    this.p2r.register(() => this.run(this.query()));
  }

  // Monotonic request id: a slow response for a query the user has already
  // typed past must not overwrite the current results, nor clear the spinner
  // that a newer in-flight request owns.
  private generation = 0;

  /** Run (or re-run) the search. Public because it's also the pull-to-refresh
   *  entry point, and because the stale-response guard is worth testing
   *  directly rather than through two racing input writes. */
  async run(q: string): Promise<void> {
    const trimmed = q.trim();
    const mine = ++this.generation;
    if (!trimmed) {
      this.results.set(EMPTY);
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.failed.set(false);
    try {
      const res = await firstValueFrom(this.api.search(trimmed));
      if (mine !== this.generation) return;
      this.results.set(res.local ?? EMPTY);
    } catch {
      if (mine !== this.generation) return;
      this.results.set(EMPTY);
      this.failed.set(true);
    } finally {
      if (mine === this.generation) this.loading.set(false);
    }
  }

  coverUrl(coverArt: string | undefined): string | undefined {
    return coverArt ? `/api/cover/${coverArt}?size=300&token=${this.auth.token()}` : undefined;
  }

  /** The found songs are the queue — a click plays in the context of the
   *  result list, matching every other song listing (issue #233). */
  playSong(index: number): void {
    const tracks = this.results().songs.map((s) => toTrack(s));
    if (tracks.length === 0) return;
    this.player.playWithContext(tracks, index, { type: 'adhoc', name: 'Search results' });
  }

  readonly toTrack = toTrack;
}
