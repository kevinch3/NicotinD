import { Component, computed, input } from '@angular/core';
import { TranslatePipe } from '../../pipes/translate.pipe';

export interface ShareSegment {
  genre: string;
  count: number;
  weight: number;
  /**
   * A synthesized bucket, not a tag: neutral tone, sorted last, own testid. Only
   * `kind` marks a bucket — a real tag named "Other" stays a ranked genre.
   */
  kind?: 'other' | 'untagged';
  /** Display percent when the caller already rounded the set to sum to 100. */
  percent?: number;
}

/**
 * Part-to-whole genre bar: one stacked bar plus a legend carrying the exact
 * percentages. The artist page's About block (#1572) feeds it a per-track
 * primary-genre share and Library Stats (#1670) a per-play one, so segments sum
 * to 100% — unlike `GenreDistributionStripComponent`, whose weights overlap.
 *
 * Colour is one hue stepped down by rank (ordinal, not categorical), with the
 * catch-all buckets neutral; the legend text carries every value, so colour is
 * never the only way to read a segment. See docs/genre-radar.md.
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
  /** Replaces the artist-page caption when set. */
  readonly caption = input<string | null>(null);

  /** Largest first, the neutral buckets last (other, then untagged), each with its tone. */
  protected readonly segments = computed(() => {
    const named = this.slices().filter((s) => neutralRank(s) < 0);
    const neutral = this.slices()
      .filter((s) => neutralRank(s) >= 0)
      .sort((a, b) => neutralRank(a) - neutralRank(b));
    const view = (s: ShareSegment, tone: string) => ({
      ...s,
      tone,
      key: s.kind ? `bucket:${s.kind}` : `genre:${s.genre}`,
      testid: s.kind ? `genre-share-bucket-${s.kind}` : `genre-share-${s.genre.toLowerCase()}`,
      percent: s.percent ?? pct(s.weight),
    });
    return [
      ...[...named]
        .sort((a, b) => b.weight - a.weight || a.genre.localeCompare(b.genre))
        .map((s, i) => view(s, `tone-${Math.min(i, 4)}`)),
      ...neutral.map((s) => view(s, 'tone-other')),
    ];
  });

  protected readonly label = computed(() =>
    this.segments()
      .map((s) => `${s.genre} ${s.percent}%`)
      .join(', '),
  );
}

/** -1 for a real genre, else the bucket's place at the end (other, then untagged). */
function neutralRank(s: ShareSegment): number {
  if (s.kind === 'untagged') return 1;
  if (s.kind === 'other') return 0;
  return -1;
}

function pct(weight: number): number {
  return Math.round(weight * 100);
}
