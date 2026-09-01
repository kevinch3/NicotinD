import { Component, inject, signal, computed, viewChild, OnInit } from '@angular/core';
import { firstValueFrom, catchError, of } from 'rxjs';
import type { LibraryFilter } from '@nicotind/core';
import { PlayerService } from '../../services/player.service';
import { AuthService } from '../../services/auth.service';
import { LibraryApiService } from '../../services/api/library-api.service';
import { ToastService } from '../../services/toast.service';
import { CoverArtComponent } from '../../components/cover-art/cover-art.component';
import { KeepVibeComponent } from '../../components/keep-vibe/keep-vibe.component';
import { RecentlyPlayedComponent } from '../../components/recently-played/recently-played.component';
import { TastemakersComponent } from '../../components/tastemakers/tastemakers.component';
import { TasteBreakersComponent } from '../../components/taste-breakers/taste-breakers.component';
import { VibeTileComponent } from '../../components/vibe-tile/vibe-tile.component';
import { toTrack } from '../../lib/track-utils';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { VIBE_PRESETS, type VibePreset } from '../../lib/vibe-presets';
import { coverUrl } from '../../lib/cover-url';

// VIBE_PRESETS moved to lib/vibe-presets.ts when the mosaic home began sharing
// them; the contrast and column-order rules that shaped the gradients live
// there with the data.

/**
 * The app's landing surface: start listening in one tap. Six blocks:
 *  1. Resume — radio seeded from your last-played track (disappears once tapped).
 *  2. Keep the vibe — list-seeded radio recommendations over the
 *     recently-played rows (KeepVibeComponent, fed the child shelf's data).
 *  3. Taste breakers — random library picks minus the recent plays, the
 *     deliberate counterweight to block 2 (TasteBreakersComponent).
 *  4. Recently played — the listening-history shelf.
 *  5. Tastemakers — curated-playlist blend radios (TastemakersComponent).
 *  6. Start a radio — vibe presets as wide colored tiles in two scrolling rows,
 *     plus the same tile muted for top genres; each starts filter-seeded radio.
 * Mobile-first (thumb-reachable chips, no manual bottom padding — inherited from
 * <main>). Music acquisition lives on the merged workspace (nav "Get", /get).
 */
@Component({
  selector: 'app-radio-landing',
  standalone: true,
  imports: [
    CoverArtComponent,
    KeepVibeComponent,
    RecentlyPlayedComponent,
    TastemakersComponent,
    TasteBreakersComponent,
    VibeTileComponent,
    TranslatePipe,
  ],
  templateUrl: './radio-landing.component.html',
})
export class RadioLandingComponent implements OnInit {
  private player = inject(PlayerService);
  private api = inject(LibraryApiService);
  private toast = inject(ToastService);
  private auth = inject(AuthService);

  readonly presets = VIBE_PRESETS;

  // The last-played track (persisted across sessions) seeds the resume shortcut;
  // it's dismissed the moment it's tapped so the block disappears.
  readonly lastTrack = this.player.currentTrack;
  readonly resumeDismissed = signal(false);
  readonly showResume = computed(() => !this.resumeDismissed() && this.lastTrack() !== null);

  // Top genres (by song count) surfaced as one-tap genre chips.
  readonly genres = signal<string[]>([]);

  // The recently-played shelf's rows feed the "Keep the vibe" shelf as radio
  // seeds — read off the child so the history is fetched exactly once.
  private recentShelf = viewChild(RecentlyPlayedComponent);
  readonly recentPlays = computed(() => this.recentShelf()?.plays() ?? []);

  // The vibe currently being loaded (preset id / genre key / 'resume'), for spinners.
  readonly starting = signal<string | null>(null);

  ngOnInit(): void {
    void this.loadGenres();
  }

  private async loadGenres(): Promise<void> {
    const rows = await firstValueFrom(this.api.getGenres().pipe(catchError(() => of([]))));
    // Already ordered by song_count desc server-side; keep the most-populated few.
    this.genres.set(rows.slice(0, 8).map((g) => g.value));
  }

  /**
   * `Track.coverArt` is a cover *id*, never a URL — build the standard
   * `/api/cover/:id?size=&token=` URL like every other cover call site. The raw
   * id used to be passed straight into <img src>, which 404s into the letter
   * placeholder while the player (building the URL properly) showed the cover.
   */
  resumeCoverSrc(): string | undefined {
    const coverArt = this.lastTrack()?.coverArt;
    return coverArt ? coverUrl(coverArt, 160, this.auth.token()) : undefined;
  }

  /** Resume radio from the last-played track, then hide the resume block. */
  onResume(): void {
    const track = this.lastTrack();
    if (!track) return;
    this.player.startRadio(track);
    this.resumeDismissed.set(true);
    this.player.nowPlayingOpen.set(true);
  }

  startPreset(preset: VibePreset): void {
    void this.startVibe(preset.filter, preset.id);
  }

  startGenre(genre: string): void {
    void this.startVibe({ genres: [genre] }, `genre:${genre}`);
  }

  /** Fetch filter-scored tracks and hand them to the player as filter radio. */
  private async startVibe(filter: LibraryFilter, key: string): Promise<void> {
    if (this.starting()) return;
    this.starting.set(key);
    try {
      const songs = await firstValueFrom(this.api.getFilterRadio(filter, [], 20));
      if (!songs.length) {
        this.toast.show({ message: 'No tracks match that vibe yet', kind: 'info' });
        return;
      }
      this.player.startRadioWithFilter(
        songs.map((s) => toTrack(s)),
        filter,
      );
      this.player.nowPlayingOpen.set(true);
    } catch {
      this.toast.show({ message: "Couldn't start radio — try again", kind: 'error' });
    } finally {
      this.starting.set(null);
    }
  }
}
