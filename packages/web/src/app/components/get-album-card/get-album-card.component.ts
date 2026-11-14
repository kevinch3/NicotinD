import { Component, computed, inject, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CoverArtComponent } from '../cover-art/cover-art.component';
import { IconComponent } from '../icon/icon.component';
import { TvNavItemDirective } from '../../directives/tv-nav-item.directive';
import { OverflowRevealDirective } from '../../directives/overflow-reveal.directive';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { TranslateService } from '../../services/translate.service';
import { resolveAlbumRoute } from '../../lib/route-utils';
import {
  IDLE_HUNT,
  albumHuntLabel,
  cancellableJobId,
  type AlbumHuntStatus,
} from '../../lib/album-hunt-status';

/** What the library already holds of the album a card names. */
export interface CardLibraryState {
  albumId: string;
  /** Fewer tracks on disk than the release has. */
  partial: boolean;
}

/**
 * One album on the Get page, whichever lane named it: a catalog release or an
 * album only a source holds. The card shows the work; its copies open from the
 * cover or the Copies button, and Get is always an explicit button.
 */
@Component({
  selector: 'app-get-album-card',
  standalone: true,
  imports: [
    RouterLink,
    CoverArtComponent,
    IconComponent,
    TvNavItemDirective,
    OverflowRevealDirective,
    TranslatePipe,
  ],
  templateUrl: './get-album-card.component.html',
  host: { class: 'block min-w-0' },
})
export class GetAlbumCardComponent {
  private readonly i18n = inject(TranslateService);

  // Not `input.required()`: see the note in album-tile.component.ts.
  readonly title = input('');
  readonly artist = input('');
  /** `1971 · Album · 12 tracks`; empty when the source knows none of it. */
  readonly meta = input('');
  readonly coverSrc = input<string | undefined>(undefined);
  readonly origin = input<'catalog' | 'provider'>('catalog');
  readonly status = input<AlbumHuntStatus>(IDLE_HUNT);
  /** The click is in flight and no job exists yet. */
  readonly preparing = input(false);
  /** `12 peers · FLAC · complete`; null once a finished search saw no copy; undefined while unknown. */
  readonly availability = input<string | null | undefined>(undefined);
  readonly hasCopies = input(false);
  /** Why the last Get of this album failed; the card says so and opens its copies. */
  readonly failed = input<string | null>(null);
  readonly library = input<CardLibraryState | null>(null);
  readonly showWatch = input(false);
  readonly watched = input(false);

  readonly get = output<void>();
  readonly copies = output<void>();
  readonly cancel = output<string>();
  readonly watch = output<void>();

  readonly busy = computed(() => this.preparing() || this.status().phase !== 'idle');
  readonly cancelJobId = computed(() => cancellableJobId(this.status()));
  readonly owned = computed(() => {
    const lib = this.library();
    return !!lib && !lib.partial;
  });
  readonly libraryRoute = computed(() => resolveAlbumRoute(this.library()?.albumId));
  readonly unseen = computed(() => !this.busy() && !this.library() && this.availability() === null);

  /** Delivered share of the job, for the bar on the cover; null without a total. */
  readonly progress = computed(() => {
    const s = this.status();
    if (s.phase !== 'job' || !s.expected) return null;
    return Math.min(100, Math.round(((s.delivered ?? 0) / s.expected) * 100));
  });

  /** The one line that changes: what is happening, else what is on offer. */
  readonly statusLine = computed(() => {
    if (this.preparing() && this.status().phase === 'idle') return this.i18n.t('acquire.preparing');
    if (this.busy()) return albumHuntLabel(this.status(), (key) => this.i18n.t(key));
    if (this.failed() !== null) return this.i18n.t('getCard.failed');
    const lib = this.library();
    if (lib) return this.i18n.t(lib.partial ? 'getCard.partlyInLibrary' : 'getCard.inLibrary');
    const availability = this.availability();
    if (availability === null) return this.i18n.t('getCard.noCopySeen');
    return availability ?? '';
  });

  readonly dataAvailability = computed(() => {
    const a = this.availability();
    return a === undefined ? 'unknown' : a === null ? 'none' : 'available';
  });

  readonly showFailed = computed(() => !this.busy() && this.failed() !== null);
  readonly copiesOffered = computed(() => this.hasCopies() || this.showFailed());

  readonly dataState = computed(() =>
    this.busy()
      ? 'busy'
      : this.showFailed()
        ? 'failed'
        : this.owned()
          ? 'in-library'
          : this.library()
            ? 'partial'
            : 'idle',
  );
}
