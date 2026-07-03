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
  imports: [CommonModule, CoverArtComponent],
  template: `
    <!-- Backdrop -->
    <div class="fixed inset-0 z-[90] bg-black/60" (click)="close.emit()"></div>

    <!-- Sheet -->
    <div
      class="fixed bottom-0 left-0 right-0 z-[91] bg-zinc-900 rounded-t-2xl shadow-2xl
             flex flex-col max-h-[80vh] transition-transform duration-300"
      [style.transform]="dragging() ? 'translateY(' + dragOffsetPx() + 'px)' : 'translateY(0)'"
      [class.transition-none]="dragging()"
      (pointerdown)="onDragStart($event)"
    >
      <!-- Grab handle -->
      <div class="flex justify-center pt-3 pb-1 cursor-grab" translate="no">
        <div class="w-10 h-1 rounded-full bg-zinc-700"></div>
      </div>

      <div class="px-5 pb-2 flex items-center justify-between">
        <h2 class="text-base font-semibold text-zinc-100">Track info</h2>
        <button
          class="text-zinc-500 hover:text-zinc-300 text-2xl leading-none"
          (click)="close.emit()"
        >
          ×
        </button>
      </div>

      <!-- Identity: always shown so the sheet says WHICH track it is (prefers the
           full Song; falls back to display inputs when opened from the player). -->
      @if (headerTitle()) {
        <div class="px-5 pb-3 flex items-center gap-3" data-testid="track-info-identity">
          <app-cover-art
            [src]="headerCoverUrl()"
            [artist]="headerArtist()"
            [album]="headerAlbum()"
            [size]="48"
            rounded="rounded"
          />
          <div class="min-w-0">
            <p class="text-sm font-medium text-zinc-100 truncate">{{ headerTitle() }}</p>
            @if (headerArtist()) {
              <p class="text-xs text-zinc-400 truncate">{{ headerArtist() }}</p>
            }
            @if (headerAlbum()) {
              <p class="text-xs text-zinc-500 truncate">{{ headerAlbum() }}</p>
            }
          </div>
        </div>
      }

      <div class="overflow-y-auto flex-1 px-5 pb-6">
        <!-- Basic file info -->
        @if (effectiveSong(); as s) {
          <section class="mb-5">
            <p class="text-xs text-zinc-500 uppercase tracking-wider mb-2">File</p>
            <div class="space-y-1 text-sm text-zinc-300">
              <div class="flex gap-2">
                <span class="text-zinc-500 w-16 flex-shrink-0">Path</span>
                <span class="break-all text-zinc-400 text-xs">{{ s.path }}</span>
              </div>
              <div class="flex gap-2">
                <span class="text-zinc-500 w-16 flex-shrink-0">Format</span>
                <span>{{ s.path.split('.').pop()?.toUpperCase() ?? '?' }}</span>
              </div>
              <div class="flex gap-2">
                <span class="text-zinc-500 w-16 flex-shrink-0">Bitrate</span>
                <span>{{ s.bitRate }} kbps</span>
              </div>
              <div class="flex gap-2">
                <span class="text-zinc-500 w-16 flex-shrink-0">Size</span>
                <span>{{ formatBytes(s.size) }}</span>
              </div>
            </div>
          </section>
        }

        <!-- Acquisition provenance (how/where-from/when) -->
        <section class="mb-5" data-testid="acquisition-section">
          <p class="text-xs text-zinc-500 uppercase tracking-wider mb-2">Acquisition</p>
          @if (acquisition(); as a) {
            <div class="space-y-1 text-sm text-zinc-300">
              <div class="flex gap-2 items-center">
                <span class="text-zinc-500 w-16 flex-shrink-0">Method</span>
                <span
                  class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-zinc-800 text-xs"
                  data-testid="acquisition-method"
                >
                  <span translate="no">{{ methodGlyph(a.method) }}</span>
                  {{ methodLabel(a.method) }}
                </span>
              </div>
              @if (a.acquiredAt) {
                <div class="flex gap-2">
                  <span class="text-zinc-500 w-16 flex-shrink-0">Acquired</span>
                  <span>{{ formatDate(a.acquiredAt) }}</span>
                </div>
              }
              @if (a.sourceRef) {
                <div class="flex gap-2">
                  <span class="text-zinc-500 w-16 flex-shrink-0">Source</span>
                  <span class="break-all text-zinc-400 text-xs">{{ a.sourceRef }}</span>
                </div>
              }
            </div>
          } @else {
            <p class="text-sm text-zinc-600">Source not recorded for this track.</p>
          }
        </section>

        <!-- Track analysis (BPM + genre) -->
        <section class="mb-5" data-testid="analysis-section">
          <p class="text-xs text-zinc-500 uppercase tracking-wider mb-2">Analysis</p>
          <div class="space-y-2 text-sm text-zinc-300">
            <!-- BPM -->
            <div class="flex gap-2 items-center">
              <span class="text-zinc-500 w-16 flex-shrink-0">BPM</span>
              @if (bpm() !== null) {
                <span data-testid="bpm-value">{{ bpm() }}</span>
                @if (bpmSource() === 'analyzed') {
                  <span class="text-xs text-zinc-600">(analyzed)</span>
                }
              } @else {
                <span class="text-zinc-600">Unknown</span>
              }
              <button
                class="ml-auto px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-xs
                       disabled:opacity-50"
                [disabled]="analyzing()"
                (click)="analyze()"
                data-testid="analyze-bpm-button"
              >
                {{ analyzing() ? 'Analyzing…' : bpm() !== null ? 'Re-analyze' : 'Analyze' }}
              </button>
            </div>

            <!-- Genre -->
            <div class="flex gap-2 items-center">
              <span class="text-zinc-500 w-16 flex-shrink-0">Genre</span>
              <span data-testid="genre-value">{{ currentGenre() || 'Unknown' }}</span>
              <button
                class="ml-auto px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-xs
                       disabled:opacity-50"
                [disabled]="verifyingGenre()"
                (click)="verifyGenreNow()"
                data-testid="verify-genre-button"
              >
                {{ verifyingGenre() ? 'Checking…' : 'Check genre' }}
              </button>
            </div>
            @if (genreSuggestion(); as g) {
              @if (g.source === null) {
                <p class="text-xs text-zinc-600">No genre source available.</p>
              } @else if (g.suggested && g.suggested !== currentGenre()) {
                <div class="flex gap-2 items-center pl-16" data-testid="genre-suggestion">
                  <span class="text-zinc-500 text-xs">Suggested</span>
                  <span class="text-zinc-300">{{ g.suggested }}</span>
                  @if (isAdmin()) {
                    <button
                      class="ml-auto px-2 py-0.5 rounded bg-blue-600 hover:bg-blue-500 text-xs
                             disabled:opacity-50"
                      [disabled]="applyingGenre()"
                      (click)="applySuggestedGenre(g.suggested!)"
                      data-testid="apply-genre-button"
                    >
                      {{ applyingGenre() ? 'Applying…' : 'Apply' }}
                    </button>
                  }
                </div>
              } @else {
                <p class="text-xs text-zinc-600 pl-16">Genre matches the source.</p>
              }
            }

            <!-- Perceptual/harmonic features (filled by server enrichment) -->
            @for (f of featureRows(); track f.label) {
              <div class="flex gap-2 items-center">
                <span class="text-zinc-500 w-20 flex-shrink-0">{{ f.label }}</span>
                @if (f.value !== null) {
                  <span [attr.data-testid]="f.testid">{{ f.value }}</span>
                } @else {
                  <span class="text-zinc-600">Unknown</span>
                }
              </div>
            }
          </div>
        </section>

        <!-- Lyrics (on-demand, plugin-sourced, editable) -->
        <section class="mb-5" data-testid="lyrics-section">
          <div class="flex items-center justify-between mb-2">
            <p class="text-xs text-zinc-500 uppercase tracking-wider">Lyrics</p>
            @if (!editingLyrics()) {
              <div class="flex gap-2">
                @if (isAdmin()) {
                  <button
                    class="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-xs"
                    (click)="startEditLyrics()"
                    data-testid="edit-lyrics-button"
                  >
                    {{ lyricsText() ? 'Edit' : 'Add' }}
                  </button>
                }
                <button
                  class="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-xs disabled:opacity-50"
                  [disabled]="fetchingLyrics()"
                  (click)="fetchLyricsNow()"
                  data-testid="fetch-lyrics-button"
                >
                  {{ fetchingLyrics() ? 'Fetching…' : lyricsText() ? 'Re-fetch' : 'Fetch lyrics' }}
                </button>
              </div>
            }
          </div>

          @if (editingLyrics()) {
            <textarea
              class="w-full h-48 rounded bg-zinc-800 text-sm text-zinc-200 p-2 resize-y
                     focus:outline-none focus:ring-1 focus:ring-blue-500"
              [value]="lyricsDraft()"
              (input)="lyricsDraft.set($any($event.target).value)"
              data-testid="lyrics-editor"
            ></textarea>
            <div class="flex gap-2 mt-2">
              <button
                class="px-2 py-0.5 rounded bg-blue-600 hover:bg-blue-500 text-xs disabled:opacity-50"
                [disabled]="savingLyrics() || !lyricsDraft().trim()"
                (click)="saveLyricsNow()"
                data-testid="save-lyrics-button"
              >
                {{ savingLyrics() ? 'Saving…' : 'Save' }}
              </button>
              <button
                class="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-xs"
                (click)="editingLyrics.set(false)"
              >
                Cancel
              </button>
              @if (lyrics()) {
                <button
                  class="ml-auto px-2 py-0.5 rounded bg-zinc-800 hover:bg-red-900 text-xs"
                  (click)="resetLyrics()"
                  data-testid="reset-lyrics-button"
                >
                  Reset
                </button>
              }
            </div>
          } @else if (lyricsText()) {
            <pre
              class="whitespace-pre-wrap font-sans text-sm text-zinc-300 max-h-64 overflow-y-auto"
              data-testid="lyrics-text"
              >{{ lyricsText() }}</pre
            >
            @if (lyrics()?.customized) {
              <p class="text-xs text-zinc-600 mt-1">Edited by you</p>
            } @else if (lyrics()?.source) {
              <p class="text-xs text-zinc-600 mt-1">Source: {{ lyrics()?.source }}</p>
            }
            @if (lyrics()?.synced) {
              <p class="text-xs text-zinc-600">Synced lyrics shown in the now-playing view.</p>
            }
          } @else if (noLyricsFound()) {
            <p class="text-sm text-zinc-600">No lyrics found for this track.</p>
          } @else {
            <p class="text-sm text-zinc-600">No lyrics yet — fetch them from a source.</p>
          }
        </section>

        <!-- Provenance history -->
        <section>
          <p class="text-xs text-zinc-500 uppercase tracking-wider mb-2">Processing history</p>

          @if (loading()) {
            <p class="text-sm text-zinc-500">Loading…</p>
          } @else if (provenance().length === 0) {
            <p class="text-sm text-zinc-600">No processing history recorded for this track.</p>
          } @else {
            <ol class="relative border-l border-zinc-700 space-y-4 ml-2">
              @for (record of provenance(); track record.appliedAt) {
                <li class="ml-4">
                  <div
                    class="absolute -left-1.5 mt-1 w-3 h-3 rounded-full bg-zinc-600 border-2 border-zinc-900"
                  ></div>
                  <p class="text-xs text-zinc-500 mb-0.5">{{ formatDate(record.appliedAt) }}</p>
                  <p class="text-sm font-medium text-zinc-200">{{ labelFor(record.action) }}</p>
                  @if (record.detail.from) {
                    <p class="text-xs text-zinc-500 mt-0.5">
                      <span class="text-zinc-600">from</span> {{ record.detail.from }}
                    </p>
                  }
                  @if (record.detail.to) {
                    <p class="text-xs text-zinc-500">
                      <span class="text-zinc-600">→</span> {{ record.detail.to }}
                    </p>
                  }
                  @if (record.detail.mb_album_title) {
                    <p class="text-xs text-zinc-500">
                      <span class="text-zinc-600">Album</span> {{ record.detail.mb_album_title }}
                    </p>
                  }
                  @if (record.detail.mb_recording_id) {
                    <a
                      [href]="'https://musicbrainz.org/recording/' + record.detail.mb_recording_id"
                      target="_blank"
                      rel="noopener"
                      class="text-xs text-blue-400 hover:underline"
                      >MusicBrainz ↗</a
                    >
                  }
                </li>
              }
            </ol>
          }
        </section>
      </div>
    </div>
  `,
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
  /** Current genre: an applied override wins over the song's own tag. */
  readonly currentGenre = computed(() => this.genreOverride() ?? this.effectiveSong()?.genre ?? '');

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
