import { Component, HostListener, computed, effect, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LibraryApiService } from '../../services/api/library-api.service';
import { ToastService } from '../../services/toast.service';
import { IconComponent } from '../icon/icon.component';

/**
 * Curator fix for an artist's genre (issue #187 A3).
 *
 * This is the highest-leverage correction surface in the library: one row fixes
 * every track by the artist, including ones downloaded later, and it survives
 * rescans because it is stored as a `library_genre_overrides` row the scanner
 * applies — not as a file tag that the next scan could revert.
 *
 * It is also the PRIMARY path rather than a fallback: MusicBrainz genre data was
 * measured to cover only 2 of 25 sampled artists on this library, so for most
 * artists there is simply nothing to fetch and a human is the only source. The
 * template leans on that — it always shows where each current genre came from,
 * so a wrong one is obvious, and states plainly what applying will do.
 */
@Component({
  selector: 'app-artist-genre-modal',
  standalone: true,
  imports: [FormsModule, IconComponent],
  templateUrl: './artist-genre-modal.component.html',
})
export class ArtistGenreModalComponent {
  private api = inject(LibraryApiService);
  private toasts = inject(ToastService);

  readonly artistId = input.required<string>();
  readonly artistName = input.required<string>();
  readonly closed = output<void>();
  /** Emitted after the server applied the override and its rescan completed. */
  readonly saved = output<void>();

  readonly current = signal<string[]>([]);
  readonly override = signal<{ genres: string[]; source: string; note: string | null } | null>(null);
  readonly draft = signal('');
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  constructor() {
    effect(() => {
      const id = this.artistId();
      this.loading.set(true);
      this.api.artistGenre(id).subscribe({
        next: (r) => {
          this.current.set(r.current);
          this.override.set(r.override);
          // Prefill with whatever is in effect so the curator edits rather than
          // retypes — the override if one exists, else the current tag genres.
          this.draft.set((r.override?.genres ?? r.current).join('; '));
          this.loading.set(false);
        },
        error: () => {
          this.error.set('Could not load this artist’s genres');
          this.loading.set(false);
        },
      });
    });
  }

  /** Where the genres currently in effect came from — the "why is this wrong" cue. */
  readonly provenance = computed(() =>
    this.override() ? (this.override()!.source === 'user' ? 'set by you' : `from ${this.override()!.source}`) : 'from file tags',
  );

  readonly parsed = computed(() =>
    this.draft()
      .split(';')
      .map((g) => g.trim())
      .filter(Boolean),
  );

  readonly canSave = computed(() => !this.busy() && this.parsed().length > 0);

  save(): void {
    if (!this.canSave()) return;
    this.busy.set(true);
    this.error.set(null);
    this.api.setArtistGenre(this.artistId(), this.parsed().join(';')).subscribe({
      next: () => {
        this.busy.set(false);
        this.toasts.show({ kind: 'success', message: 'Artist genre updated.' });
        this.saved.emit();
        this.closed.emit();
      },
      error: (err: { error?: { error?: string } }) => {
        this.busy.set(false);
        this.error.set(err?.error?.error ?? 'Failed to save the genre');
      },
    });
  }

  reset(): void {
    this.busy.set(true);
    this.api.clearArtistGenre(this.artistId()).subscribe({
      next: () => {
        this.busy.set(false);
        this.toasts.show({ kind: 'success', message: 'Reverted to the genres in the file tags.' });
        this.saved.emit();
        this.closed.emit();
      },
      error: () => {
        this.busy.set(false);
        this.error.set('Failed to reset');
      },
    });
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.closed.emit();
  }
}
