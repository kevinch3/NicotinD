import { Component, computed, inject, signal } from '@angular/core';
import {
  VARIETIES,
  describeLibraryFilter,
  strategyForVariety,
  varietyForStrategy,
  type StrategyId,
  type Variety,
} from '@nicotind/core';
import { firstValueFrom } from 'rxjs';
import { PlayerService } from '../../../services/player.service';
import { LibraryApiService } from '../../../services/api/library-api.service';
import { RecommendationsApiService } from '../../../services/api/recommendations-api.service';
import { TranslateService } from '../../../services/translate.service';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { TvNavGroupDirective } from '../../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../../directives/tv-nav-item.directive';
import type { FeedbackKind } from '../../../services/api/api-types';
import { OverflowRevealDirective } from '../../../directives/overflow-reveal.directive';

/**
 * The vote a move logs against the playing track, keyed by the strategy it
 * moves to: moving farther says the radio was too close. Unchanged on the wire
 * since before the dial (docs/radio.md "Variety chip").
 */
const KIND_FOR_STRATEGY: Record<StrategyId, FeedbackKind> = {
  different: 'too_similar',
  balanced: 'balanced',
  similar: 'too_different',
};

/**
 * The radio pill in Now Playing, grown a suffix: the main button still toggles
 * radio (same `now-playing-radio` contract), the chevron expands a panel that
 * says what the radio is playing from and offers the three-position variety
 * control. A move steers now (PlayerService swaps the radio-appended queue
 * tail) and is logged as a vote against the playing track, then remembered as
 * this user's default. The control is a Close · Medium · Far dial whose
 * mapping to strategies lives in one core function; the provenance footer
 * reuses the segment's label keys, so both speak one vocabulary (#1660). The
 * footer describes the last generated queue, so it can lag a fresh move.
 */
@Component({
  selector: 'app-radio-chip',
  imports: [OverflowRevealDirective, TranslatePipe, TvNavGroupDirective, TvNavItemDirective],
  templateUrl: './radio-chip.component.html',
})
export class RadioChipComponent {
  readonly player = inject(PlayerService);
  private readonly api = inject(RecommendationsApiService);
  private readonly library = inject(LibraryApiService);
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
    // The anchor, not the playing track: a song radio is about the song it
    // started from, however far along it is (#1277).
    const anchor = this.player.radioAnchor();
    if (anchor?.kind === 'list') {
      return anchor.name
        ? this.i18n.t('nowPlaying.radioList', { name: anchor.name })
        : this.i18n.t('nowPlaying.radioListUnnamed');
    }
    const title = anchor?.kind === 'song' ? anchor.title : this.player.currentTrack()?.title;
    return title ? this.i18n.t('nowPlaying.radioSeed', { title }) : '';
  });

  /**
   * How the queue was generated (#1124): version, genre axis and strategy.
   * Null before the first player-lane refill, and against a server that does
   * not send the envelope — the panel then simply omits the line rather than
   * guessing a version it cannot know.
   */
  readonly provenance = this.library.radioProvenance;

  /** `formula v9 · Medium · genre by sound` — one line, already translated. */
  readonly provenanceLabel = computed(() => {
    const p = this.provenance();
    if (!p) return '';
    return [
      this.i18n.t('nowPlaying.radioFormula', { version: String(p.formulaVersion) }),
      this.i18n.t(this.labelKey(varietyForStrategy(p.strategy))),
      this.i18n.t(`nowPlaying.radioAxis.${p.genreAxis}`),
    ].join(' · ');
  });

  toggleExpanded(): void {
    this.expanded.update((v) => !v);
  }

  collapse(): void {
    this.expanded.set(false);
  }

  labelKey(v: Variety): string {
    switch (v) {
      case 'close':
        return 'nowPlaying.varietyClose';
      case 'far':
        return 'nowPlaying.varietyFar';
      default:
        return 'nowPlaying.varietyMedium';
    }
  }

  select(v: Variety): void {
    const from = this.player.radioStrategy();
    const to = strategyForVariety(v);
    if (from === to) return;
    this.player.setRadioStrategy(to);
    const track = this.player.currentTrack();
    if (track) {
      // The vote is against the playing track, in the context of what the
      // radio is about: its filter, or its anchor (#1277).
      const filter = this.player.radioFilter();
      const anchor = filter ? null : this.player.radioAnchor();
      void firstValueFrom(
        this.api.feedback(track.id, KIND_FOR_STRATEGY[to], {
          strategyFrom: from,
          strategyTo: to,
          seedId: anchor?.kind === 'song' ? anchor.id : undefined,
          seedIds: anchor?.kind === 'list' ? anchor.ids : undefined,
          filter: filter ?? undefined,
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
