import { Component, computed, inject, signal } from '@angular/core';
import { catchError, firstValueFrom, of } from 'rxjs';
import { HistoryApiService } from '../../services/api/history-api.service';
import {
  GenreShareBarComponent,
  type ShareSegment,
} from '../../components/genre-share-bar/genre-share-bar.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { TranslateService } from '../../services/translate.service';
import { sharePercents } from '../../lib/share-percents';
import { TvNavGroupDirective } from '../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../directives/tv-nav-item.directive';
import type { ListeningStats, StatsPeriod } from '../../services/api/api-types';

interface PeriodOption {
  value: StatsPeriod;
  label: string;
}

/** One row of the genre share: a real genre, or a synthesized bucket. */
export interface GenreRow {
  key: string;
  label: string;
  plays: number;
  share: number;
  percent: number;
  kind?: 'other' | 'untagged';
}

const PERIODS: PeriodOption[] = [
  { value: '30d', label: 'stats.period.30d' },
  { value: 'year', label: 'stats.period.year' },
  { value: 'all', label: 'stats.period.all' },
];

/**
 * Library "Stats" tab — what you actually listened to, over a period.
 *
 * Lives in its own file rather than inside `library.component` (already 7 tabs
 * and ~760 lines), matching `LibraryFindComponent`. All aggregation happens
 * server-side; this component only picks a period and draws.
 *
 * The genre block is a part-to-whole share of the period's plays, each play
 * counted once by its track's primary genre, so the rows sum to 100% (#1670);
 * the overlapping every-genre count is a separate mode with no percentages.
 *
 * See docs/listening-history.md.
 */
@Component({
  selector: 'app-library-stats',
  imports: [
    GenreShareBarComponent,
    TranslatePipe,
    // The period picker and genre mode switch are the only focusable controls
    // here, so they must be D-pad reachable — Library is a TV surface.
    TvNavGroupDirective,
    TvNavItemDirective,
  ],
  templateUrl: './library-stats.component.html',
})
export class LibraryStatsComponent {
  private readonly api = inject(HistoryApiService);
  private readonly i18n = inject(TranslateService);

  readonly periods = PERIODS;
  readonly genreModes = ['share', 'all'] as const;
  readonly period = signal<StatsPeriod>('30d');
  readonly stats = signal<ListeningStats | null>(null);
  readonly loading = signal(false);
  /** Distinguishes "still loading" from "loaded, and there is nothing here". */
  readonly loaded = signal(false);

  readonly hasHistory = computed(() => (this.stats()?.totals.plays ?? 0) > 0);

  /** `share`: each play once by primary genre; `all`: overlapping counts, no %. */
  readonly genreMode = signal<'share' | 'all'>('share');

  /** False against a pre-#1670 server (no `genreShare`): only the counts can be drawn. */
  readonly hasGenreShare = computed(() => this.genreRows().length > 0);

  readonly effectiveGenreMode = computed(() => (this.hasGenreShare() ? this.genreMode() : 'all'));

  /** Named genres, then the "Other genres" and "Untagged" buckets; percents sum to 100. */
  readonly genreRows = computed<GenreRow[]>(() => {
    const gs = this.stats()?.genreShare;
    if (!gs || gs.totalPlays === 0) return [];
    const rows: Omit<GenreRow, 'percent'>[] = gs.slices.map((s) => ({
      key: s.genre,
      label: s.genre,
      plays: s.plays,
      share: s.share,
    }));
    if (gs.other.plays > 0) {
      rows.push({
        key: 'other',
        label: this.i18n.t('stats.genreOther'),
        plays: gs.other.plays,
        share: gs.other.share,
        kind: 'other',
      });
    }
    if (gs.untagged.plays > 0) {
      rows.push({
        key: 'untagged',
        label: this.i18n.t('stats.genreUntagged'),
        plays: gs.untagged.plays,
        share: gs.untagged.share,
        kind: 'untagged',
      });
    }
    const percents = sharePercents(rows.map((r) => r.plays));
    return rows.map((r, i) => ({ ...r, percent: percents[i] ?? 0 }));
  });

  readonly genreSegments = computed<ShareSegment[]>(() =>
    this.genreRows().map((r) => ({
      genre: r.label,
      count: r.plays,
      weight: r.share,
      percent: r.percent,
      kind: r.kind,
    })),
  );

  /** "+N more genres · P%" for the folded tail, or null when nothing folded. */
  readonly genreTailCaption = computed(() => {
    const other = this.stats()?.genreShare?.other;
    const row = this.genreRows().find((r) => r.kind === 'other');
    return other && row ? { count: other.genreCount, percent: row.percent } : null;
  });

  /**
   * Clock bars as percentages of the busiest hour. Percent-of-max rather than
   * percent-of-total: the shape of the day is the point, and shares of total
   * would render every bar as an unreadable sliver across 24 buckets.
   */
  readonly clockBars = computed(() => {
    const clock = this.stats()?.clock ?? [];
    const max = Math.max(0, ...clock);
    return clock.map((plays, hour) => ({
      hour,
      plays,
      percent: max > 0 ? Math.round((plays / max) * 100) : 0,
    }));
  });

  constructor() {
    void this.load();
  }

  async setPeriod(period: StatsPeriod): Promise<void> {
    if (period === this.period()) return;
    this.period.set(period);
    await this.load();
  }

  /** Non-fatal: a failed load leaves the empty state rather than an error page. */
  private async load(): Promise<void> {
    this.loading.set(true);
    const res = await firstValueFrom(
      this.api.getStats(this.period()).pipe(catchError(() => of(null))),
    );
    this.stats.set(res);
    this.loading.set(false);
    this.loaded.set(true);
  }

  /** "12h 34m" / "34m" / "2m" — hours only when there are some. */
  formatDuration(ms: number): string {
    const totalMinutes = Math.floor(ms / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  }

  /** 0, 6, 12, 18 only — 24 labels never fit on a phone. */
  hourLabel(hour: number): string {
    return hour % 6 === 0 ? String(hour) : '';
  }
}
