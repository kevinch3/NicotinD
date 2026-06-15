import { Component, input, output, signal, computed, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import type { AcquisitionMethod, GenreSuggestion, SongAcquisition } from '@nicotind/core';
import { ApiService, type ProvenanceRecord, type Song } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { methodBadge } from '../../lib/acquisition-method';
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
        @if (song(); as s) {
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
          </div>
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
  private api = inject(ApiService);
  private auth = inject(AuthService);

  readonly songId = input.required<string>();
  readonly song = input<Song | null>(null);
  // Lightweight identity for callers (the player) that have a Track but not a
  // full library Song — so the sheet can always say which track it is.
  readonly displayTitle = input('');
  readonly displayArtist = input('');
  readonly displayAlbum = input('');
  readonly displayCoverArt = input<string | null>(null);
  readonly close = output<void>();

  // Identity header — prefer the full Song, fall back to the display inputs.
  readonly headerTitle = computed(() => this.song()?.title ?? this.displayTitle());
  readonly headerArtist = computed(() => this.song()?.artist ?? this.displayArtist());
  readonly headerAlbum = computed(() => this.song()?.album ?? this.displayAlbum());
  readonly headerCoverUrl = computed(() => {
    const id = this.song()?.coverArt ?? this.displayCoverArt();
    return id ? `/api/cover/${id}?size=96&token=${this.auth.token()}` : undefined;
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
  readonly currentGenre = computed(() => this.genreOverride() ?? this.song()?.genre ?? '');

  // Swipe-down-to-dismiss — mirrors now-playing.component pattern
  readonly dragging = signal(false);
  readonly dragOffsetPx = signal(0);
  private dragStartY = 0;
  private onDocMove: ((e: PointerEvent) => void) | null = null;
  private onDocUp: ((e: PointerEvent) => void) | null = null;

  ngOnInit(): void {
    const known = this.song()?.bpm;
    if (known) {
      this.bpm.set(known);
      this.bpmSource.set('tag');
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
