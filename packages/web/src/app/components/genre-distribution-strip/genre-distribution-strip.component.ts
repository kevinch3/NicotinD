import { Component, computed, input } from '@angular/core';

export interface GenreSlice {
  genre: string;
  count: number;
  weight: number;
}

/**
 * Read-only listener-facing genre-weight strip for artist/album pages (issue
 * #222 sub-goal 2). Deliberately a plain CSS bar list, not the SVG radar
 * (`GenreRadarComponent`) that curation uses — a strip is a linear form, and
 * the codebase already has this exact bar-fill pattern in
 * `TrackStatsBarsComponent`. No interaction with the curation/reclassify flow.
 */
@Component({
  selector: 'app-genre-distribution-strip',
  templateUrl: './genre-distribution-strip.component.html',
  styleUrls: ['./genre-distribution-strip.component.css'],
})
export class GenreDistributionStripComponent {
  /** Not required: "given slices, draw them; given none, render nothing." */
  readonly slices = input<GenreSlice[]>([]);
  readonly trackCount = input<number>(0);
  /** Distinct genres before the "Other" fold, to caption what was hidden. */
  readonly genreCount = input<number>(0);

  protected readonly rows = computed(() => [...this.slices()].sort((a, b) => b.weight - a.weight));

  protected readonly hiddenCount = computed(() =>
    Math.max(0, this.genreCount() - this.slices().filter((s) => s.genre !== 'Other').length),
  );

  protected percent(weight: number): number {
    return Math.round(weight * 100);
  }
}
