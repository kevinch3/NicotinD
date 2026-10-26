import { Component, computed, input } from '@angular/core';
import { TranslatePipe } from '../../pipes/translate.pipe';

export interface ShareSegment {
  genre: string;
  count: number;
  weight: number;
}

/**
 * Part-to-whole genre bar for the artist page's About block (#1572): one
 * stacked bar plus a legend carrying the exact percentages. Fed the API's
 * primary-genre share, so segments sum to 100% — unlike
 * `GenreDistributionStripComponent`, whose weights overlap by design.
 *
 * Colour is one hue stepped down by rank (ordinal, not categorical), with
 * "Other" neutral; the legend text carries every value, so colour is never the
 * only way to read a segment. See docs/genre-radar.md.
 */
@Component({
  selector: 'app-genre-share-bar',
  imports: [TranslatePipe],
  templateUrl: './genre-share-bar.component.html',
  styleUrls: ['./genre-share-bar.component.css'],
})
export class GenreShareBarComponent {
  readonly slices = input<ShareSegment[]>([]);
  /** Tracks with a primary genre — the whole the bar divides. */
  readonly taggedCount = input<number>(0);

  /** Largest first, "Other" always last, each with its rank-step class. */
  protected readonly segments = computed(() => {
    const named = this.slices().filter((s) => s.genre !== 'Other');
    const other = this.slices().filter((s) => s.genre === 'Other');
    return [
      ...[...named]
        .sort((a, b) => b.weight - a.weight || a.genre.localeCompare(b.genre))
        .map((s, i) => ({ ...s, tone: `tone-${Math.min(i, 4)}`, percent: pct(s.weight) })),
      ...other.map((s) => ({ ...s, tone: 'tone-other', percent: pct(s.weight) })),
    ];
  });

  protected readonly label = computed(() =>
    this.segments()
      .map((s) => `${s.genre} ${s.percent}%`)
      .join(', '),
  );
}

function pct(weight: number): number {
  return Math.round(weight * 100);
}
