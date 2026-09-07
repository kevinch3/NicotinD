import { Component, computed, inject, signal } from '@angular/core';
import {
  VARIETIES,
  describeLibraryFilter,
  strategyForVariety,
  varietyForStrategy,
  type Variety,
} from '@nicotind/core';
import { firstValueFrom } from 'rxjs';
import { PlayerService } from '../../../services/player.service';
import { RecommendationsApiService } from '../../../services/api/recommendations-api.service';
import { TranslateService } from '../../../services/translate.service';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { TvNavGroupDirective } from '../../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../../directives/tv-nav-item.directive';
import type { FeedbackKind } from '../../../services/api/api-types';

/** The vote a position logs against the playing track (docs/radio.md "Variety chip"). */
const KIND_FOR_VARIETY: Record<Variety, FeedbackKind> = {
  'too-similar': 'too_similar',
  balanced: 'balanced',
  'too-different': 'too_different',
};

/**
 * The radio pill in Now Playing, grown a suffix: the main button still toggles
 * radio (same `now-playing-radio` contract), the chevron expands a panel that
 * says what the radio is playing from and offers the three-position variety
 * control. A move steers now (PlayerService swaps the radio-appended queue
 * tail) and is logged as a vote against the playing track, then remembered as
 * this user's default. Labels are complaints, strategies are remedies — the
 * mapping lives in one core function so it cannot ship inverted.
 */
@Component({
  selector: 'app-radio-chip',
  imports: [TranslatePipe, TvNavGroupDirective, TvNavItemDirective],
  templateUrl: './radio-chip.component.html',
})
export class RadioChipComponent {
  readonly player = inject(PlayerService);
  private readonly api = inject(RecommendationsApiService);
  private readonly i18n = inject(TranslateService);

  readonly VARIETIES = VARIETIES;
  readonly expanded = signal(false);

  /** The control's position, derived from the player's strategy. */
  readonly variety = computed(() => varietyForStrategy(this.player.radioStrategy()));

  /** What the radio is playing from, for the panel's first line. */
  readonly description = computed(() => {
    if (!this.player.radio()) return this.i18n.t('nowPlaying.radioIdle');
    const filter = this.player.radioFilter();
    if (filter) {
      return this.i18n.t('nowPlaying.radioStation', { label: describeLibraryFilter(filter) });
    }
    const track = this.player.currentTrack();
    return track ? this.i18n.t('nowPlaying.radioSeed', { title: track.title }) : '';
  });

  toggleExpanded(): void {
    this.expanded.update((v) => !v);
  }

  collapse(): void {
    this.expanded.set(false);
  }

  labelKey(v: Variety): string {
    switch (v) {
      case 'too-similar':
        return 'nowPlaying.varietyTooSimilar';
      case 'too-different':
        return 'nowPlaying.varietyTooDifferent';
      default:
        return 'nowPlaying.varietyBalanced';
    }
  }

  select(v: Variety): void {
    const from = this.player.radioStrategy();
    const to = strategyForVariety(v);
    if (from === to) return;
    this.player.setRadioStrategy(to);
    const track = this.player.currentTrack();
    if (track) {
      void firstValueFrom(
        this.api.feedback(track.id, KIND_FOR_VARIETY[v], {
          strategyFrom: from,
          strategyTo: to,
          seedId: this.player.radioFilter() ? undefined : track.id,
          filter: this.player.radioFilter() ?? undefined,
        }),
      ).catch(() => {});
    }
    void firstValueFrom(this.api.setPreferences(to)).catch(() => {});
  }

  /** Arrow keys move the position; the roving-tabindex group handles focus. */
  onKeydown(event: KeyboardEvent): void {
    const idx = VARIETIES.indexOf(this.variety());
    if (event.key === 'ArrowLeft' && idx > 0) {
      event.preventDefault();
      this.select(VARIETIES[idx - 1]!);
    } else if (event.key === 'ArrowRight' && idx < VARIETIES.length - 1) {
      event.preventDefault();
      this.select(VARIETIES[idx + 1]!);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.collapse();
    }
  }
}
