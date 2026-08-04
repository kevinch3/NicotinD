import { Component, inject, input, output } from '@angular/core';
import { PlayerService } from '../../../services/player.service';
import { AuthService } from '../../../services/auth.service';
import { CoverArtComponent } from '../../cover-art/cover-art.component';
import { ArtistLinksComponent } from '../../artist-links/artist-links.component';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { formatQuality } from '../../../lib/download-status';
import { TvNavItemDirective } from '../../../directives/tv-nav-item.directive';

@Component({
  selector: 'app-now-playing-cover-art',
  imports: [CoverArtComponent, ArtistLinksComponent, TranslatePipe, TvNavItemDirective],
  // `display: contents` so the host doesn't break the sheet's flex column —
  // the shell's flex container needs to see this component's own top-level
  // element as the flex item, and `contents` makes the host transparent.
  host: { class: 'contents' },
  templateUrl: './now-playing-cover-art.component.html',
})
export class NowPlayingCoverArtComponent {
  readonly player = inject(PlayerService);
  readonly auth = inject(AuthService);

  readonly coverMaxPx = input<number>(320);
  readonly resizing = input(false);

  readonly openTrackInfo = output<string>();
  readonly titleContextMenu = output<MouseEvent>();
  readonly navigateToArtistClicked = output<void>();

  formatQuality(bitrateKbps?: number | null): string {
    return formatQuality(bitrateKbps, null);
  }
}
