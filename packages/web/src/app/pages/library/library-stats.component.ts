import { Component, computed, inject, signal } from '@angular/core';
import { catchError, firstValueFrom, of } from 'rxjs';
import { HistoryApiService } from '../../services/api/history-api.service';
import { GenreDistributionStripComponent } from '../../components/genre-distribution-strip/genre-distribution-strip.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { TvNavGroupDirective } from '../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../directives/tv-nav-item.directive';
import type { ListeningStats, StatsPeriod } from '../../services/api/api-types';

interface PeriodOption {
  value: StatsPeriod;
  label: string;
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
 * The genre block reuses `GenreDistributionStripComponent` from the
 * artist/album pages rather than inventing a second bar chart — same visual
 * language, and its `weight` input is already a 0..1 share.
 *
 * See docs/listening-history.md.
 */
@Component({
  selector: 'app-library-stats',
  imports: [
    GenreDistributionStripComponent,
    TranslatePipe,
    // The period picker is the only focusable control here, so it must be
    // D-pad reachable — Library is a TV surface.
    TvNavGroupDirective,
    TvNavItemDirective,
  ],
  templateUrl: './library-stats.component.html',
})
export class LibraryStatsComponent {
  private readonly api = inject(HistoryApiService);

  readonly periods = PERIODS;
  readonly period = signal<StatsPeriod>('30d');
  readonly stats = signal<ListeningStats | null>(null);
  readonly loading = signal(false);
  /** Distinguishes "still loading" from "loaded, and there is nothing here". */
  readonly loaded = signal(false);

  readonly hasHistory = computed(() => (this.stats()?.totals.plays ?? 0) > 0);

  /** Genre plays as 0..1 shares of the top genre, for the shared strip. */
  readonly genreSlices = computed(() => {
    const genres = this.stats()?.topGenres ?? [];
    const max = genres[0]?.plays ?? 0;
    if (max === 0) return [];
    return genres.map((g) => ({ genre: g.genre, count: g.plays, weight: g.plays / max }));
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
