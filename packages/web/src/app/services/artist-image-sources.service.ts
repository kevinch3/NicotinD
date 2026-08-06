import { Injectable, computed, inject, signal } from '@angular/core';
import { LibraryApiService } from './api/library-api.service';

/**
 * Session-cached view of which artist-image sources are live (issue #422),
 * backing the enable/disable state of the "Fetch automatically" menu entry.
 *
 * why a root service: `ArtistImageMenuComponent` renders once per tile on the
 * curator's Artists grid, so fetching per component would fire N identical
 * requests for a value that only changes when an admin toggles a plugin. One
 * lazy fetch per session is enough — a stale "disabled" heals on the next app
 * load, and the server route stays the authority either way.
 */
@Injectable({ providedIn: 'root' })
export class ArtistImageSourcesService {
  private readonly api = inject(LibraryApiService);

  /** null = not yet loaded; the auto-fetch entry stays enabled until we know. */
  readonly sources = signal<string[] | null>(null);

  /** True only when the server has told us no source could serve a portrait. */
  readonly autoFetchUnavailable = computed(() => this.sources()?.length === 0);

  private loading = false;

  ensureLoaded(): void {
    if (this.loading || this.sources() !== null) return;
    this.loading = true;
    this.api.artistImageSources().subscribe({
      next: (r) => this.sources.set(r.sources),
      // Leave `sources` null so a later menu open retries; the button stays
      // enabled meanwhile (the server-side fill is safe to call regardless).
      error: () => (this.loading = false),
    });
  }
}
