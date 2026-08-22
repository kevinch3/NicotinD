import { Component, OnInit, inject, signal } from '@angular/core';
import { catchError, firstValueFrom, of } from 'rxjs';
import { LibraryApiService } from '../../services/api/library-api.service';
import { PlaylistsApiService } from '../../services/api/playlists-api.service';
import { PlayerService, shuffleArray } from '../../services/player.service';
import { ToastService } from '../../services/toast.service';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { toTrack } from '../../lib/track-utils';
import type { PlaylistSummary, Song } from '../../services/api/api-types';

/** Shelf size — the curated list is server-ordered newest-refreshed first. */
const SHELF_CAP = 10;
/** How many of the playlist's actual tracks lead the blend. */
const BLEND_PICKS = 3;
/** How many centroid-scored variations fill the queue behind them. */
const BLEND_VARIATIONS = 10;
/** The server slices `seedIds` to 20 (routes/radio.ts) — mirror it so the
 *  centroid is computed from the songs we actually sent. */
const SEED_CAP = 20;

/**
 * "Tastemakers" shelf — the curated playlists (static shelves + auto recipes,
 * both `kind='curated'`) surfaced on the landing page as one-tap radios.
 *
 * Tapping a tile starts a **blend** radio: a shuffled handful of the shelf's
 * actual tracks up front, then list-seeded variations (the `seedIds` lane,
 * same engine as "Keep the vibe") — so it feels like that tastemaker's radio
 * without replaying the whole list verbatim (the playlist page does that).
 * When the blend drains, the radio seed lane continues from the tail track.
 *
 * Covers are the designed gradient SVGs bundled with the SPA
 * (`/playlist-covers/<slug>.svg`) rendered via a plain `<img>` — deliberately
 * NOT `<app-cover-art>`, which rewrites `src` through the API base URL (see
 * docs/curated-playlists.md "Covers").
 *
 * Hide-when-empty like the sibling shelves — and no skeleton: a fresh install
 * has zero curated playlists until the auto-refresh cadence runs, so a
 * skeleton would flash-then-vanish (the failure `shouldShowRecentSkeleton`
 * exists to prevent), and there is no persisted "curated exists" proxy.
 */
@Component({
  selector: 'app-tastemakers',
  standalone: true,
  imports: [TranslatePipe],
  template: `
    @if (shelf().length > 0) {
      <section data-testid="tastemakers">
        <h2 class="text-lg font-bold text-theme-primary mb-3">{{ 'home.tastemakers' | t }}</h2>
        <div class="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1">
          @for (playlist of shelf(); track playlist.id) {
            <button
              type="button"
              (click)="onPlay(playlist)"
              [disabled]="starting() !== null"
              data-testid="tastemaker-item"
              [attr.data-playlist-id]="playlist.id"
              class="shrink-0 w-28 text-left group active:scale-95 transition disabled:opacity-50"
            >
              <div class="relative w-28 h-28">
                @if (playlist.coverArt) {
                  <img
                    [src]="playlist.coverArt"
                    [alt]="playlist.name"
                    class="w-28 h-28 rounded-lg object-cover"
                  />
                } @else {
                  <div
                    class="w-28 h-28 rounded-lg bg-theme-surface-2 flex items-center justify-center text-2xl font-bold text-theme-muted"
                    aria-hidden="true"
                  >
                    {{ playlist.name.charAt(0) }}
                  </div>
                }
                @if (starting() === playlist.id) {
                  <span
                    class="absolute inset-0 flex items-center justify-center rounded-lg bg-black/40"
                  >
                    <span
                      class="w-5 h-5 rounded-full border-2 border-white border-t-transparent animate-spin"
                    ></span>
                  </span>
                }
              </div>
              <p class="mt-1.5 text-xs font-semibold text-theme-primary truncate">
                {{ playlist.name }}
              </p>
              <p class="text-xs text-theme-muted truncate">
                {{ playlist.songCount }} {{ 'home.tastemakerSongs' | t }}
              </p>
            </button>
          }
        </div>
      </section>
    }
  `,
})
export class TastemakersComponent implements OnInit {
  private api = inject(PlaylistsApiService);
  private radioApi = inject(LibraryApiService);
  private player = inject(PlayerService);
  private toast = inject(ToastService);

  readonly shelf = signal<PlaylistSummary[]>([]);
  /** The playlist id whose blend is loading (two round trips), for the spinner. */
  readonly starting = signal<string | null>(null);

  ngOnInit(): void {
    void this.load();
  }

  /** Non-fatal: an unreachable playlists endpoint just leaves the shelf hidden. */
  private async load(): Promise<void> {
    const res = await firstValueFrom(
      this.api.getPlaylists().pipe(catchError(() => of({ playlists: [] as PlaylistSummary[] }))),
    );
    this.shelf.set(res.playlists.filter((p) => p.kind === 'curated').slice(0, SHELF_CAP));
  }

  onPlay(playlist: PlaylistSummary): void {
    void this.startBlend(playlist);
  }

  /**
   * The blend, composed client-side: a shuffled sample of the shelf's own
   * tracks, then one list-seeded generation over (up to) its first 20 songs.
   * The variations are re-filtered against the *whole* playlist because the
   * server caps seeds at 20 — for a longer shelf the engine can't know the
   * tail songs are members, so "never replay the list" is enforced here.
   */
  private async startBlend(playlist: PlaylistSummary): Promise<void> {
    if (this.starting()) return;
    this.starting.set(playlist.id);
    try {
      const detail = await firstValueFrom(this.api.getPlaylist(playlist.id));
      const songs = detail.songs;
      if (songs.length === 0) {
        this.toast.show({ message: 'This playlist is empty right now', kind: 'info' });
        return;
      }
      const picks = shuffleArray(songs).slice(0, BLEND_PICKS);
      const seedIds = songs.slice(0, SEED_CAP).map((s) => s.id);
      // Degradation, not failure: if the radio engine is unreachable the
      // picks still play alone (radio's seed lane takes over from there).
      const variations = await firstValueFrom(
        this.radioApi
          .getListRadio(seedIds, BLEND_VARIATIONS)
          .pipe(catchError(() => of([] as Song[]))),
      );
      const inPlaylist = new Set(songs.map((s) => s.id));
      const extras = variations.filter((s) => !inPlaylist.has(s.id));
      this.player.startRadioWithTracks([...picks, ...extras].map((s) => toTrack(s)));
      this.player.nowPlayingOpen.set(true);
    } catch {
      this.toast.show({ message: "Couldn't start radio — try again", kind: 'error' });
    } finally {
      this.starting.set(null);
    }
  }
}
