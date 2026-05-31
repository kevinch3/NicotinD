import {
  Component,
  input,
  output,
  signal,
  computed,
  effect,
  inject,
  OnInit,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ApiService, type ProvenanceRecord, type Song } from '../../services/api.service';

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
  imports: [CommonModule],
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
        <button class="text-zinc-500 hover:text-zinc-300 text-2xl leading-none" (click)="close.emit()">×</button>
      </div>

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
                  <div class="absolute -left-1.5 mt-1 w-3 h-3 rounded-full bg-zinc-600 border-2 border-zinc-900"></div>
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
                    >MusicBrainz ↗</a>
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

  readonly songId = input.required<string>();
  readonly song = input<Song | null>(null);
  readonly close = output<void>();

  readonly provenance = signal<ProvenanceRecord[]>([]);
  readonly loading = signal(true);

  // Swipe-down-to-dismiss — mirrors now-playing.component pattern
  readonly dragging = signal(false);
  readonly dragOffsetPx = signal(0);
  private dragStartY = 0;
  private onDocMove: ((e: PointerEvent) => void) | null = null;
  private onDocUp: ((e: PointerEvent) => void) | null = null;

  ngOnInit(): void {
    this.api.getSongProvenance(this.songId()).subscribe({
      next: (records) => { this.provenance.set(records); this.loading.set(false); },
      error: () => { this.loading.set(false); },
    });
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
