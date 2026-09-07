import { Component, OnInit, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SettingsGroupComponent } from '../../../components/settings-group/settings-group.component';
import { TrackRowComponent } from '../../../components/track-row/track-row.component';
import { TvNavGroupDirective } from '../../../directives/tv-nav-group.directive';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { PlayerService } from '../../../services/player.service';
import { RecommendationExclusionsService } from '../../../services/recommendation-exclusions.service';
import { toTrack } from '../../../lib/track-utils';
import type { ExcludedSong } from '../../../services/api/api-types';

/**
 * Settings → Recommendations: the songs this listener has told the feeds not
 * to propose, explicit and skip-derived, each with a way back in. The list is
 * the undo for both kinds — a derived exclusion has no other surface.
 * See docs/radio.md "Per-user exclusions".
 */
@Component({
  selector: 'app-recommendations-settings',
  imports: [
    RouterLink,
    SettingsGroupComponent,
    TrackRowComponent,
    TvNavGroupDirective,
    TranslatePipe,
  ],
  templateUrl: './recommendations.component.html',
})
export class RecommendationsSettingsComponent implements OnInit {
  readonly exclusions = inject(RecommendationExclusionsService);
  private readonly player = inject(PlayerService);

  ngOnInit(): void {
    void this.exclusions.refresh();
  }

  track(e: ExcludedSong) {
    return toTrack(e.song ?? { id: e.songId, title: e.songId, artist: '' });
  }

  /** i18n key for the row's reason line; the page's spec pins the mapping. */
  reasonKey(e: ExcludedSong): string {
    if (!e.song) return 'recommendations.gone';
    return e.reason === 'skips' ? 'recommendations.reasonSkips' : 'recommendations.reasonExplicit';
  }

  play(e: ExcludedSong): void {
    if (e.song) this.player.playSingle(toTrack(e.song));
  }

  restore(e: ExcludedSong): void {
    void this.exclusions.restore(e.songId);
  }
}
