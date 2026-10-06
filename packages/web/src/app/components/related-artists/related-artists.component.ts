import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { RelatedArtist } from '../../services/api/api-types';
import { CoverArtComponent } from '../cover-art/cover-art.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { TvNavGroupDirective } from '../../directives/tv-nav-group.directive';

/**
 * A scrolling row of library artists related to the one on the page
 * (docs/related-artists.md). Renders nothing when the list is empty — a page
 * never shows an empty shelf.
 */
@Component({
  selector: 'app-related-artists',
  standalone: true,
  imports: [RouterLink, CoverArtComponent, TranslatePipe, TvNavGroupDirective],
  templateUrl: './related-artists.component.html',
})
export class RelatedArtistsComponent {
  readonly artists = input<RelatedArtist[]>([]);
  /** Auth token for the local `/api/cover/<hash>` URL. */
  readonly token = input<string | null>(null);

  coverSrc(a: RelatedArtist): string | undefined {
    return a.coverArt ? `/api/cover/${a.coverArt}?size=160&token=${this.token() ?? ''}` : undefined;
  }
}
