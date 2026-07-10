import { Component, inject } from '@angular/core';
import { TrackInfoService } from '../../services/track-info.service';
import { TrackInfoSheetComponent } from '../track-info-sheet/track-info-sheet.component';

@Component({
  selector: 'app-track-info-host',
  imports: [TrackInfoSheetComponent],
  template: `
    @if (info.target(); as t) {
      <app-track-info-sheet
        [songId]="t.songId"
        [displayTitle]="t.title ?? ''"
        [displayArtist]="t.artist ?? ''"
        [displayAlbum]="t.album ?? ''"
        [displayCoverArt]="t.coverArt ?? null"
        (close)="info.close()"
      />
    }
  `,
})
export class TrackInfoHostComponent {
  readonly info = inject(TrackInfoService);
}
