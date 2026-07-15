import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom, catchError, of } from 'rxjs';
import { MOOD_VOCAB, type LibraryFilter, type MoodLabel } from '@nicotind/core';
import { PlayerService } from '../../services/player.service';
import { LibraryApiService } from '../../services/api/library-api.service';
import { ToastService } from '../../services/toast.service';
import { CoverArtComponent } from '../../components/cover-art/cover-art.component';
import { toTrack } from '../../lib/track-utils';

/** A one-tap "vibe": a friendly label + emoji over a canonical LibraryFilter. */
interface VibePreset {
  id: string;
  label: string;
  emoji: string;
  filter: LibraryFilter;
}

// Simplified, human-named starters mapped onto the shared filter vocabulary
// (moods, perceptual buckets, bpm). Each starts filter-seeded radio instantly.
const VIBE_PRESETS: readonly VibePreset[] = [
  { id: 'happy', label: 'Happy', emoji: '😊', filter: { moods: ['happy'] } },
  { id: 'chill', label: 'Chill', emoji: '😌', filter: { moods: ['relaxed'] } },
  { id: 'party', label: 'Party', emoji: '🎉', filter: { moods: ['party'] } },
  { id: 'energetic', label: 'Energetic', emoji: '⚡', filter: { buckets: { energy: ['high'] } } },
  {
    id: 'danceable',
    label: 'Danceable',
    emoji: '💃',
    filter: { buckets: { danceability: ['high'] } },
  },
  { id: 'uplifting', label: 'Uplifting', emoji: '☀️', filter: { buckets: { valence: ['high'] } } },
  { id: 'fast', label: '120bpm+', emoji: '🏃', filter: { bpmMin: 120 } },
  {
    id: 'acoustic',
    label: 'Acoustic',
    emoji: '🎸',
    filter: { buckets: { acousticness: ['high'] } },
  },
];

// Quick BPM floors offered in the custom builder.
const BPM_CHOICES = [
  { label: 'Any', value: undefined },
  { label: '120+', value: 120 },
  { label: '140+', value: 140 },
] as const;

/**
 * The app's landing surface: start listening in one tap. Two blocks:
 *  1. Resume — radio seeded from your last-played track (disappears once tapped).
 *  2. New mood — one-tap vibe presets + a compact custom builder (mood + genre +
 *     bpm), each of which starts filter-seeded radio immediately.
 * Mobile-first (thumb-reachable chips, no manual bottom padding — inherited from
 * <main>). Search moved to /search; a search bar here links to it.
 */
@Component({
  selector: 'app-radio-landing',
  standalone: true,
  imports: [RouterLink, CoverArtComponent],
  templateUrl: './radio-landing.component.html',
})
export class RadioLandingComponent implements OnInit {
  private player = inject(PlayerService);
  private api = inject(LibraryApiService);
  private toast = inject(ToastService);

  readonly presets = VIBE_PRESETS;
  readonly moods = MOOD_VOCAB;
  readonly bpmChoices = BPM_CHOICES;

  // The last-played track (persisted across sessions) seeds the resume shortcut;
  // it's dismissed the moment it's tapped so the block disappears.
  readonly lastTrack = this.player.currentTrack;
  readonly resumeDismissed = signal(false);
  readonly showResume = computed(() => !this.resumeDismissed() && this.lastTrack() !== null);

  // Top genres (by song count) surfaced as one-tap genre chips + custom-builder options.
  readonly genres = signal<string[]>([]);

  // Custom builder state.
  readonly customOpen = signal(false);
  readonly customMood = signal<MoodLabel | null>(null);
  readonly customGenre = signal<string | null>(null);
  readonly customBpm = signal<number | undefined>(undefined);

  // The vibe currently being loaded (preset id / 'custom' / 'resume'), for spinners.
  readonly starting = signal<string | null>(null);

  ngOnInit(): void {
    void this.loadGenres();
  }

  private async loadGenres(): Promise<void> {
    const rows = await firstValueFrom(this.api.getGenres().pipe(catchError(() => of([]))));
    // Already ordered by song_count desc server-side; keep the most-populated few.
    this.genres.set(rows.slice(0, 8).map((g) => g.value));
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

  toggleMood(mood: MoodLabel): void {
    this.customMood.update((m) => (m === mood ? null : mood));
  }

  toggleGenre(genre: string): void {
    this.customGenre.update((g) => (g === genre ? null : genre));
  }

  setBpm(value: number | undefined): void {
    this.customBpm.set(value);
  }

  /** Whether the custom builder has at least one criterion selected. */
  readonly customFilter = computed<LibraryFilter | null>(() => {
    const filter: LibraryFilter = {};
    const mood = this.customMood();
    const genre = this.customGenre();
    const bpm = this.customBpm();
    if (mood) filter.moods = [mood];
    if (genre) filter.genres = [genre];
    if (bpm !== undefined) filter.bpmMin = bpm;
    return Object.keys(filter).length > 0 ? filter : null;
  });

  startCustom(): void {
    const filter = this.customFilter();
    if (!filter) return;
    void this.startVibe(filter, 'custom');
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
