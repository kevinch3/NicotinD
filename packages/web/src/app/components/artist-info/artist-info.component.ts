import { Component, inject, input, output, signal } from '@angular/core';
import { LibraryApiService } from '../../services/api/library-api.service';
import { AuthService } from '../../services/auth.service';
import { ToastService } from '../../services/toast.service';

/**
 * Inline artist bio + external links section (issue #195), sourced from
 * Discogs. Read-mostly display content — an inline section, not a modal —
 * with a curator-gated refresh action.
 */
@Component({
  selector: 'app-artist-info',
  standalone: true,
  templateUrl: './artist-info.component.html',
})
export class ArtistInfoComponent {
  private api = inject(LibraryApiService);
  private toasts = inject(ToastService);
  readonly auth = inject(AuthService);

  readonly artistId = input.required<string>();
  readonly bio = input<string | null>(null);
  readonly urls = input<string[]>([]);
  /** Emitted after a successful refresh so the parent page can update its own signal. */
  readonly updated = output<{ bio: string | null; urls: string[] }>();

  readonly shownBio = signal<string | null | undefined>(undefined);
  readonly shownUrls = signal<string[] | undefined>(undefined);
  readonly refreshing = signal(false);
  readonly expanded = signal(false);

  /** Falls back to the input until a refresh overrides it locally. */
  effectiveBio(): string | null {
    const local = this.shownBio();
    return local !== undefined ? local : this.bio();
  }

  effectiveUrls(): string[] {
    const local = this.shownUrls();
    return local !== undefined ? local : this.urls();
  }

  refresh(): void {
    if (this.refreshing()) return;
    this.refreshing.set(true);
    this.api.refreshArtistInfo(this.artistId()).subscribe({
      next: (r) => {
        this.refreshing.set(false);
        this.shownBio.set(r.bio);
        this.shownUrls.set(r.urls);
        this.updated.emit(r);
        this.toasts.show({ kind: 'success', message: 'Artist info refreshed.' });
      },
      error: () => {
        this.refreshing.set(false);
        this.toasts.show({ kind: 'error', message: 'Could not refresh artist info.' });
      },
    });
  }

  toggleExpanded(): void {
    this.expanded.set(!this.expanded());
  }
}
