import { Component, inject, input, output } from '@angular/core';
import { PlayerService } from '../../../services/player.service';
import { AuthService } from '../../../services/auth.service';
import { CoverArtComponent } from '../../cover-art/cover-art.component';
import { ArtistLinksComponent } from '../../artist-links/artist-links.component';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { formatQuality } from '../../../lib/download-status';

@Component({
  selector: 'app-now-playing-cover-art',
  imports: [CoverArtComponent, ArtistLinksComponent, TranslatePipe],
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
