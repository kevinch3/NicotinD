import { Component, inject, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { NotOwnedRelatedArtist, RelatedArtist } from '../../services/api/api-types';
import { TvNavItemDirective } from '../../directives/tv-nav-item.directive';
import { CoverArtComponent } from '../cover-art/cover-art.component';
import { CoverRevisionsService } from '../../services/cover-revisions.service';
import { artistCover } from '../../lib/cover-url';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { TvNavGroupDirective } from '../../directives/tv-nav-group.directive';
import { OverflowRevealDirective } from '../../directives/overflow-reveal.directive';

/**
 * A scrolling row of library artists related to the one on the page
 * (docs/related-artists.md). Renders nothing when the list is empty — a page
 * never shows an empty shelf.
 */
@Component({
  selector: 'app-related-artists',
  standalone: true,
  imports: [
    OverflowRevealDirective,
    RouterLink,
    CoverArtComponent,
    TranslatePipe,
    TvNavGroupDirective,
    TvNavItemDirective,
  ],
  templateUrl: './related-artists.component.html',
})
export class RelatedArtistsComponent {
  readonly artists = input<RelatedArtist[]>([]);
  /** Related artists the library does not have: each is a way into the Get search (#1486). */
  readonly notOwned = input<NotOwnedRelatedArtist[]>([]);
  /** The name of a not-owned artist the user wants to look for. */
  readonly find = output<string>();
  /** Auth token for the local `/api/cover/<hash>` URL. */
  readonly token = input<string | null>(null);

  private readonly coverRevisions = inject(CoverRevisionsService);

  /** The portrait at its live cover rev, so a change made elsewhere shows here (#1666). */
  coverSrc(a: RelatedArtist): string | undefined {
    return this.coverRevisions.url(artistCover(a), 160, this.token());
  }
}
