import { Component, computed, inject, input, output, signal } from '@angular/core';
import { ALL_COUNTRY_CODES, countryFlagEmoji } from '@nicotind/core';
import { AuthService } from '../../services/auth.service';
import { LibraryApiService } from '../../services/api/library-api.service';

export interface ArtistOriginValue {
  country: string | null;
  source: string;
}

/**
 * Artist origin line (docs/artist-origin.md): flag emoji (derived
 * arithmetically from the ISO code — zero assets) + a country name localized
 * via `Intl.DisplayNames`, with a curator-gated inline searchable picker.
 * The display surface doubles as the data-quality feedback loop: a wrong flag
 * on an artist page gets noticed and fixed; a wrong value in a table never
 * does. Picking "No origin" writes a permanent user tombstone server-side.
 */
@Component({
  selector: 'app-artist-origin',
  template: `
    @if (origin()?.country; as country) {
      <button
        type="button"
        class="flex items-center gap-1 text-sm text-theme-muted"
        [class.cursor-default]="!canEdit()"
        (click)="canEdit() && toggleEditor()"
        data-testid="artist-origin"
      >
        <span aria-hidden="true">{{ flag(country) }}</span>
        <span>{{ label(country) }}</span>
      </button>
    } @else if (canEdit()) {
      <button
        type="button"
        class="text-sm text-theme-muted underline underline-offset-2"
        (click)="toggleEditor()"
        data-testid="artist-origin-set"
      >
        Set origin
      </button>
    }
    @if (editing()) {
      <div class="mt-1 flex flex-col gap-1 max-w-60">
        <input
          type="text"
          class="px-2 py-1 text-sm rounded bg-theme-surface-2 text-theme-secondary"
          placeholder="Search country…"
          [value]="query()"
          (input)="query.set($any($event.target).value)"
          data-testid="artist-origin-search"
        />
        <div class="flex flex-wrap gap-1">
          @for (code of matches(); track code) {
            <button
              type="button"
              class="px-2 py-0.5 text-xs rounded-full bg-theme-surface-2 text-theme-secondary transition"
              (click)="pick(code)"
              [disabled]="busy()"
              [attr.data-testid]="'artist-origin-opt-' + code"
            >
              {{ flag(code) }} {{ label(code) }}
            </button>
          }
          <button
            type="button"
            class="px-2 py-0.5 text-xs rounded-full bg-theme-surface-2 text-theme-secondary transition"
            (click)="pick(null)"
            [disabled]="busy()"
            data-testid="artist-origin-clear"
          >
            No origin (confirmed)
          </button>
        </div>
      </div>
    }
  `,
})
export class ArtistOriginComponent {
  private readonly auth = inject(AuthService);
  private readonly api = inject(LibraryApiService);

  readonly artistId = input.required<string>();
  readonly origin = input<ArtistOriginValue | null>(null);
  /** Emits the saved value so the parent can patch its artist signal in place. */
  readonly changed = output<ArtistOriginValue>();

  readonly editing = signal(false);
  readonly busy = signal(false);
  readonly query = signal('');

  readonly canEdit = computed(() => this.auth.canCurate());

  private readonly regionNames = new Intl.DisplayNames([navigator.language || 'en'], {
    type: 'region',
  });

  flag(code: string): string {
    return countryFlagEmoji(code);
  }

  label(code: string): string {
    return this.regionNames.of(code) ?? code;
  }

  /** Substring match on the localized name or the code itself, capped at 8. */
  readonly matches = computed(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) return [];
    return ALL_COUNTRY_CODES.filter(
      (code) => code.toLowerCase() === q || this.label(code).toLowerCase().includes(q),
    ).slice(0, 8);
  });

  toggleEditor(): void {
    this.editing.update((v) => !v);
    this.query.set('');
  }

  pick(country: string | null): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.api.setArtistOrigin(this.artistId(), country).subscribe({
      next: (res) => {
        this.busy.set(false);
        this.editing.set(false);
        this.changed.emit({ country: res.origin.country, source: res.origin.source });
      },
      error: () => this.busy.set(false),
    });
  }
}
