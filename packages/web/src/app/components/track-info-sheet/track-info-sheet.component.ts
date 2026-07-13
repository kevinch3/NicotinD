import { Component, input, output, signal, computed, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import type {
  AcquisitionMethod,
  GenreSuggestion,
  LyricsDto,
  SongAcquisition,
} from '@nicotind/core';
import { LibraryApiService } from '../../services/api/library-api.service';
import type { ProvenanceRecord, Song } from '../../services/api/api-types';
import { AuthService } from '../../services/auth.service';
import { ServerConfigService } from '../../services/server-config.service';
import { methodBadge } from '../../lib/acquisition-method';
import { parseLrc } from '../../lib/lrc-parser';
import { CoverArtComponent } from '../cover-art/cover-art.component';
import { TrackStatsBarsComponent } from '../track-stats-bars/track-stats-bars.component';
import { ArtistIdentityModalComponent } from '../artist-identity-modal/artist-identity-modal.component';

const ACTION_LABELS: Record<string, string> = {
  duplicate_removed: 'Duplicate removed',
  artist_folder_merged: 'Artist folder merged',
  album_folder_merged: 'Album folder merged',
  moved_from_singles: 'Moved from Singles to album',
  album_renamed: 'Album name normalized',
};

@Component({
  selector: 'app-track-info-sheet',
  standalone: true,
  imports: [CommonModule, CoverArtComponent, TrackStatsBarsComponent, ArtistIdentityModalComponent],
  templateUrl: './track-info-sheet.component.html',
})
export class TrackInfoSheetComponent implements OnInit {
  private api = inject(LibraryApiService);
  private auth = inject(AuthService);
  private server = inject(ServerConfigService);

  readonly songId = input.required<string>();
  readonly song = input<Song | null>(null);
  // Lightweight identity for callers (the player) that have a Track but not a
  // full library Song — so the sheet can always say which track it is.
  readonly displayTitle = input('');
  readonly displayArtist = input('');
  readonly displayAlbum = input('');
  readonly displayCoverArt = input<string | null>(null);
  readonly close = output<void>();

  // Song the sheet renders from: the caller's Song when given, otherwise the
  // one we lazily fetch by id (callers like the player pass only a songId, so
  // without this the stored bpm/genre would never load → always "Unknown").
  private readonly loadedSong = signal<Song | null>(null);
  readonly effectiveSong = computed(() => this.song() ?? this.loadedSong());

  // Identity header — prefer the full Song, fall back to the display inputs.
  readonly headerTitle = computed(() => this.effectiveSong()?.title ?? this.displayTitle());
  readonly headerArtist = computed(() => this.effectiveSong()?.artist ?? this.displayArtist());
  readonly headerAlbum = computed(() => this.effectiveSong()?.album ?? this.displayAlbum());
  readonly headerCoverUrl = computed(() => {
    const id = this.effectiveSong()?.coverArt ?? this.displayCoverArt();
    return id
      ? this.server.apiUrl(`/api/cover/${id}?size=96&token=${this.auth.token()}`)
      : undefined;
  });

  readonly provenance = signal<ProvenanceRecord[]>([]);
  readonly acquisition = signal<SongAcquisition | null>(null);
  readonly loading = signal(true);

  // Track analysis state
  readonly bpm = signal<number | null>(null);
  readonly bpmSource = signal<'tag' | 'analyzed' | null>(null);
  readonly analyzing = signal(false);
  readonly genreOverride = signal<string | null>(null);
  readonly genreSuggestion = signal<GenreSuggestion | null>(null);
  readonly verifyingGenre = signal(false);
  readonly applyingGenre = signal(false);
  readonly isAdmin = computed(() => this.auth.role() === 'admin');

  // Admin fix for a wrong artist-credit decision, acting on the song's RAW tag
  // artist string (covers compounds that no longer have their own artist page).
  readonly identityOpen = signal(false);
  /** Current genre: an applied override wins over the song's own tag. */
  readonly currentGenre = computed(() => this.genreOverride() ?? this.effectiveSong()?.genre ?? '');

  /** Full genre set for the chips row (primary first). An applied override
   *  (possibly a ';'-joined list) replaces the whole set until refetch. */
  readonly genreList = computed<string[]>(() => {
    const override = this.genreOverride();
    if (override !== null) {
      return override
        .split(/[;,|]/)
        .map((g) => g.trim())
        .filter(Boolean);
    }
    const s = this.effectiveSong();
    if (s?.genres?.length) return s.genres;
    return s?.genre ? [s.genre] : [];
  });

  /** Read-only perceptual/harmonic rows for the Analysis section ("Unknown"
   *  until the server enrichment has analyzed the track). */
  readonly featureRows = computed(() => {
    const s = this.effectiveSong();
    const pct = (v: number | undefined): string | null =>
      typeof v === 'number' ? `${Math.round(v * 100)}%` : null;
    const mood = s?.mood ? s.mood.charAt(0).toUpperCase() + s.mood.slice(1) : null;
    return [
      { label: 'Key', value: s?.key ?? null, testid: 'key-value' },
      { label: 'Energy', value: pct(s?.energy), testid: 'energy-value' },
      { label: 'Mood', value: mood, testid: 'mood-value' },
      { label: 'Valence', value: pct(s?.valence), testid: 'valence-value' },
      { label: 'Dance', value: pct(s?.danceability), testid: 'danceability-value' },
      { label: 'Acoustic', value: pct(s?.acousticness), testid: 'acousticness-value' },
      { label: 'Instrumental', value: pct(s?.instrumental), testid: 'instrumental-value' },
    ];
  });

  // Lyrics state
  readonly lyrics = signal<LyricsDto | null>(null);
  readonly fetchingLyrics = signal(false);
  readonly noLyricsFound = signal(false);
  readonly editingLyrics = signal(false);
  readonly lyricsDraft = signal('');
  readonly savingLyrics = signal(false);
  /** Display text: plain wins; otherwise strip the synced LRC down to its words. */
  readonly lyricsText = computed(() => {
    const l = this.lyrics();
    if (!l) return '';
    if (l.plain) return l.plain;
    if (l.synced) return parseLrc(l.synced).map((line) => line.text).join('\n');
    return '';
  });

  // Swipe-down-to-dismiss — mirrors now-playing.component pattern
  readonly dragging = signal(false);
  readonly dragOffsetPx = signal(0);
  private dragStartY = 0;
  private onDocMove: ((e: PointerEvent) => void) | null = null;
  private onDocUp: ((e: PointerEvent) => void) | null = null;

  ngOnInit(): void {
    const provided = this.song();
    if (provided?.bpm) {
      this.bpm.set(provided.bpm);
      this.bpmSource.set('tag');
    }
    // Callers that pass only a songId (the player) have no Song to read the
    // stored bpm/genre from — fetch it so analysis values render instead of
    // "Unknown".
    if (!provided) {
      this.api.getSong(this.songId()).subscribe({
        next: (s) => {
          this.loadedSong.set(s);
          if (s.bpm) {
            this.bpm.set(s.bpm);
            this.bpmSource.set('tag');
          }
        },
        error: () => this.loadedSong.set(null),
      });
    }
    this.api.getSongProvenance(this.songId()).subscribe({
      next: (records) => {
        this.provenance.set(records);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
      },
    });
    this.api.getSongAcquisition(this.songId()).subscribe({
      next: (acq) => this.acquisition.set(acq),
      error: () => this.acquisition.set(null),
    });
    this.api.getLyrics(this.songId()).subscribe({
      next: (l) => this.lyrics.set(l),
      error: () => this.lyrics.set(null),
    });
  }

  fetchLyricsNow(): void {
    if (this.fetchingLyrics()) return;
    this.fetchingLyrics.set(true);
    this.noLyricsFound.set(false);
    // Force a re-fetch when we already have a (cached/edited) row.
    this.api.fetchLyrics(this.songId(), this.lyrics() !== null).subscribe({
      next: (l) => {
        this.lyrics.set(l);
        this.noLyricsFound.set(l === null);
        this.fetchingLyrics.set(false);
      },
      error: () => this.fetchingLyrics.set(false),
    });
  }

  startEditLyrics(): void {
    this.lyricsDraft.set(this.lyricsText());
    this.editingLyrics.set(true);
  }

  saveLyricsNow(): void {
    const plain = this.lyricsDraft().trim();
    if (this.savingLyrics() || !plain) return;
    this.savingLyrics.set(true);
    this.api.saveLyrics(this.songId(), plain).subscribe({
      next: (l) => {
        this.lyrics.set(l);
        this.savingLyrics.set(false);
        this.editingLyrics.set(false);
      },
      error: () => this.savingLyrics.set(false),
    });
  }

  resetLyrics(): void {
    this.api.deleteLyrics(this.songId()).subscribe({
      next: () => {
        this.lyrics.set(null);
        this.noLyricsFound.set(false);
        this.editingLyrics.set(false);
        this.lyricsDraft.set('');
      },
    });
  }

  analyze(): void {
    if (this.analyzing()) return;
    this.analyzing.set(true);
    this.api.analyzeSong(this.songId()).subscribe({
      next: (r) => {
        this.bpm.set(r.bpm);
        this.bpmSource.set(r.source);
        this.analyzing.set(false);
      },
      error: () => this.analyzing.set(false),
    });
  }

  verifyGenreNow(): void {
    if (this.verifyingGenre()) return;
    this.verifyingGenre.set(true);
    this.api.getGenreSuggestion(this.songId()).subscribe({
      next: (g) => {
        this.genreSuggestion.set(g);
        this.verifyingGenre.set(false);
      },
      error: () => this.verifyingGenre.set(false),
    });
  }

  applySuggestedGenre(genre: string): void {
    if (this.applyingGenre()) return;
    this.applyingGenre.set(true);
    this.api.applyGenre(this.songId(), genre).subscribe({
      next: () => {
        this.genreOverride.set(genre);
        this.applyingGenre.set(false);
      },
      error: () => this.applyingGenre.set(false),
    });
  }

  methodLabel(method: AcquisitionMethod): string {
    return methodBadge(method).label;
  }

  methodGlyph(method: AcquisitionMethod): string {
    return methodBadge(method).glyph;
  }

  onDragStart(e: PointerEvent): void {
    if ((e.target as HTMLElement).closest('a, button, .overflow-y-auto')) return;
    this.dragging.set(true);
    this.dragOffsetPx.set(0);
    this.dragStartY = e.clientY;

    this.onDocMove = (ev: PointerEvent) => {
      const delta = Math.max(0, ev.clientY - this.dragStartY);
      this.dragOffsetPx.set(delta);
    };
    this.onDocUp = (ev: PointerEvent) => {
      const delta = Math.max(0, ev.clientY - this.dragStartY);
      this.dragging.set(false);
      this.dragOffsetPx.set(0);
      if (delta > 120) this.close.emit();
      document.removeEventListener('pointermove', this.onDocMove!);
      document.removeEventListener('pointerup', this.onDocUp!);
    };
    document.addEventListener('pointermove', this.onDocMove);
    document.addEventListener('pointerup', this.onDocUp, { once: true });
  }

  labelFor(action: string): string {
    return ACTION_LABELS[action] ?? action.replace(/_/g, ' ');
  }

  formatDate(ts: number): string {
    return new Date(ts).toLocaleString();
  }

  formatBytes(bytes: number): string {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
}
