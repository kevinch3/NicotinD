import { Component, computed, input } from '@angular/core';
import { radarAxes, polygonPoints, ringPoints, truncateLabel } from '../../lib/radar-geometry';

export interface GenreSlice {
  genre: string;
  count: number;
  weight: number;
}

/** Wider than tall: side labels need horizontal room the spokes don't use. */
const WIDTH = 340;
const HEIGHT = 250;
const RADIUS = 74;
const CENTER = { cx: WIDTH / 2, cy: HEIGHT / 2, radius: RADIUS };
/** Background rings at 25/50/75/100% — enough to read a level, few enough to recede. */
const RING_FRACTIONS = [0.25, 0.5, 0.75, 1];

/**
 * Genre distribution as a radar (issue #222). One series, so the accent hue
 * carries it and no legend is needed — the title names it. The value table is
 * not an accessibility afterthought: a radar distorts magnitude (enclosed area
 * grows with the square of the radius), so the table is where exact numbers
 * are read. See docs/genre-radar.md.
 */
@Component({
  selector: 'app-genre-radar',
  templateUrl: './genre-radar.component.html',
})
export class GenreRadarComponent {
  /**
   * Not `input.required`: the component's contract is "given slices, draw them;
   * given none, render nothing" (the template's `@if` already handles empty), so
   * a required input buys nothing and turns an unbound render into a thrown
   * NG0950 mid-change-detection. The JIT vitest harness doesn't register signal
   * inputs on a nested imported component (NG0303), so a required input there
   * crashes the *host* component's whole spec — which is exactly what it did.
   */
  readonly slices = input<GenreSlice[]>([]);
  /** Denominator behind every weight, shown so a small sample is obvious. */
  readonly trackCount = input<number>(0);
  /** Distinct genres before the "Other" fold, to caption what was hidden. */
  readonly genreCount = input<number>(0);

  protected readonly width = WIDTH;
  protected readonly height = HEIGHT;
  protected readonly center = CENTER;
  protected readonly ringFractions = RING_FRACTIONS;

  /** A polygon needs 3 points; below that the radar renders as spokes + dots. */
  protected readonly isPolygon = computed(() => this.slices().length >= 3);

  protected readonly axes = computed(() =>
    radarAxes(
      this.slices().map((s) => ({ label: s.genre, value: s.weight })),
      CENTER,
    ).map((a) => ({ ...a, short: truncateLabel(a.label) })),
  );

  protected readonly shape = computed(() => polygonPoints(this.axes()));

  protected readonly rings = computed(() =>
    RING_FRACTIONS.map((f) => ringPoints(Math.max(3, this.slices().length), f, CENTER)),
  );

  /** Rows for the paired table, highest share first. */
  protected readonly rows = computed(() =>
    [...this.slices()].sort((a, b) => b.weight - a.weight),
  );

  protected readonly hiddenCount = computed(() =>
    Math.max(0, this.genreCount() - this.slices().filter((s) => s.genre !== 'Other').length),
  );

  protected percent(weight: number): string {
    return `${Math.round(weight * 100)}%`;
  }
}
