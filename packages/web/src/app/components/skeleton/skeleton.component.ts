import { Component, computed, input } from '@angular/core';

/**
 * Shape-matched loading placeholder for a list, grid or detail header.
 *
 * The rule this component exists to enforce: **a spinner means an action the
 * user started is in progress; a skeleton means content is coming and its shape
 * is already known.** Before this, every fetching list rendered the same
 * copy-pasted 20px spinner centred in `py-20` dead space as a *sibling* of the
 * grid it stood in for, so a 5-column poster wall resolved out of an empty page
 * and the layout jumped hard on arrival.
 *
 * Each `variant` owns **both** its container classes and its item markup, so
 * "shape-matched" is a property of this component rather than of the caller —
 * a primitive that call sites assembled into grids would just recreate the
 * copy-paste as a dozen hand-built placeholder blocks that drift from the lists
 * they mirror.
 *
 * The host element **is** the container: `<app-skeleton>` carries the grid/stack
 * classes itself, so it drops into the same DOM position as the real list
 * container with no wrapper div. Every variant's class string therefore has to
 * start with an explicit display class — an unknown element is `inline` by
 * default, which silently collapses the vertical rhythm of a stacked variant.
 *
 * Motion is a gentle opacity pulse (1 → 0.6, 1.8s, `ease-in-out`) defined once
 * on `.skeleton-block` in `styles.css`, not Tailwind's `animate-pulse` — see
 * that file for why the curve differs. Placeholders mounted by the same `@if`
 * flip share a start time and so pulse in lockstep; never add an
 * `animation-delay`, and never render a skeleton adjacent to one that is
 * already animating. Motion is disabled under `prefers-reduced-motion` and on
 * the eink theme; the shape alone still says "loading".
 *
 * Accessibility: a labelled skeleton is a `role="status"` live region named by
 * `aria-label`; an unlabelled one is `aria-hidden`. When a page renders two
 * skeletons (a header plus a list) only the first takes a label, so two live
 * regions never compete. The subtree is deliberately textless — a clipped
 * `.sr-only` string is exactly what an axe contrast check reports as
 * incomplete.
 *
 * See docs/web-ui.md "List loading skeletons".
 */
export type SkeletonVariant =
  /** 5-col cover grid: albums, singles/EPs, compilations, discography, find results. */
  | 'album-tile'
  /** 5-col round-avatar grid: the Artists tab. */
  | 'artist-tile'
  /** 4-col bordered text card grid: the Genres tab. */
  | 'genre-tile'
  /** Vertical `TrackRowComponent` stack: every song listing. */
  | 'track-row'
  /** Horizontal scroller: the "Recently played" shelf. */
  | 'shelf-tile'
  /** Large square cover + title block: album, playlist and share pages. */
  | 'detail-header'
  /** 80px round cover + title block: the artist page. */
  | 'artist-header'
  /** Scattered squares filling the stage: the mosaic home. */
  | 'mosaic';

/**
 * Container classes per variant, copied verbatim from the real list they stand
 * in for so the skeleton occupies the identical box. `skeleton-shape.spec.ts`
 * asserts these strings still appear in those templates.
 */
const CONTAINER: Record<SkeletonVariant, string> = {
  'album-tile': 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4',
  'artist-tile': 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4',
  'genre-tile': 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3',
  'track-row': 'block space-y-0.5',
  'shelf-tile': 'flex gap-3 overflow-x-auto pb-2 -mx-1 px-1',
  'detail-header': 'flex flex-col sm:flex-row items-center sm:items-end gap-6 mb-8',
  'artist-header': 'flex items-center gap-5 mb-8',
  // The mosaic's "list" is a free canvas, so there is no grid to mirror; the
  // host just fills whatever box the page absolutely positions it in.
  mosaic: 'block absolute inset-0 overflow-hidden',
};

/** Placeholder count when the caller doesn't pick one. */
const DEFAULT_COUNT: Record<SkeletonVariant, number> = {
  'album-tile': 10,
  'artist-tile': 10,
  'genre-tile': 8,
  'track-row': 8,
  'shelf-tile': 6,
  'detail-header': 1,
  'artist-header': 1,
  mosaic: 12,
};

/** Variants that render exactly one block regardless of what the caller asks for. */
const SINGLETON: ReadonlySet<SkeletonVariant> = new Set<SkeletonVariant>([
  'detail-header',
  'artist-header',
]);

/** Upper bound on rendered placeholders — a typo'd `count` must not lock the page up. */
const MAX_COUNT = 60;

/**
 * Title-bar widths, cycled by index. A wall of identical 75%-wide bars reads
 * mechanical; real titles vary. Deterministic rather than random so Storybook
 * output is reproducible and the spec can assert on it.
 */
const BAR_WIDTHS = ['w-3/5', 'w-4/5', 'w-2/3', 'w-3/4', 'w-1/2'] as const;

/** Host classes for a variant. A non-empty `override` replaces them wholesale. */
export function skeletonContainerClass(variant: SkeletonVariant, override = ''): string {
  return override.trim() !== '' ? override : CONTAINER[variant];
}

/**
 * How many placeholders to render: the variant default unless the caller picks,
 * clamped to 1..60. Header variants ignore the request entirely — they stand in
 * for one thing, and repeating a page header would be nonsense.
 */
export function skeletonItemCount(variant: SkeletonVariant, requested?: number): number {
  if (SINGLETON.has(variant)) return 1;
  const n = requested ?? DEFAULT_COUNT[variant];
  if (!Number.isFinite(n)) return DEFAULT_COUNT[variant];
  return Math.max(1, Math.min(MAX_COUNT, Math.floor(n)));
}

/** The `@for` source — index list, since placeholders carry no data. */
export function skeletonItems(variant: SkeletonVariant, requested?: number): number[] {
  return Array.from({ length: skeletonItemCount(variant, requested) }, (_, i) => i);
}

export interface SkeletonAria {
  role: 'status' | null;
  ariaLabel: string | null;
  ariaBusy: 'true' | null;
  ariaHidden: 'true' | null;
}

/**
 * The whole a11y contract as data.
 *
 * A labelled skeleton announces (`role="status"` + `aria-busy`, named by
 * `aria-label` so the subtree stays textless). An unlabelled one is decorative
 * and hidden outright. The two are mutually exclusive by construction — a
 * hidden live region is a contradiction, and asserting that is cheaper than
 * discovering it in the axe gate.
 */
export function skeletonAria(label: string): SkeletonAria {
  const named = label.trim() !== '';
  return {
    role: named ? 'status' : null,
    ariaLabel: named ? label : null,
    ariaBusy: named ? 'true' : null,
    ariaHidden: named ? null : 'true',
  };
}

/** Width class for the title bar at `index`. Deterministic; cycles every 5. */
export function skeletonBarWidth(index: number): string {
  const i = Math.abs(Math.floor(index)) % BAR_WIDTHS.length;
  return BAR_WIDTHS[i];
}

export interface MosaicSkeletonSpot {
  left: string;
  top: string;
  width: string;
}

/**
 * Hand-placed scatter for the `mosaic` variant: mixed sizes around a large
 * centre tile, mimicking the packed field the loop will draw. Percent-based so
 * one table serves phone and desktop; the clamp keeps a square from ballooning
 * on an ultrawide stage or vanishing on a phone. Deterministic (a fixed table,
 * cycled) for the same reason `skeletonBarWidth` is.
 */
const MOSAIC_SPOTS: readonly [number, number, number][] = [
  [40, 36, 22],
  [12, 10, 14],
  [68, 12, 16],
  [30, 8, 12],
  [8, 44, 16],
  [72, 44, 16],
  [18, 74, 16],
  [44, 68, 14],
  [66, 68, 15],
  [88, 26, 10],
  [54, 14, 11],
  [90, 60, 10],
];

export function mosaicSkeletonSpot(index: number): MosaicSkeletonSpot {
  const [left, top, w] = MOSAIC_SPOTS[Math.abs(Math.floor(index)) % MOSAIC_SPOTS.length];
  return { left: `${left}%`, top: `${top}%`, width: `clamp(64px, ${w}%, 220px)` };
}

@Component({
  selector: 'app-skeleton',
  standalone: true,
  templateUrl: './skeleton.component.html',
  host: {
    '[class]': 'wrapperClass()',
    '[attr.role]': 'aria().role',
    '[attr.aria-label]': 'aria().ariaLabel',
    '[attr.aria-busy]': 'aria().ariaBusy',
    '[attr.aria-hidden]': 'aria().ariaHidden',
    '[attr.data-testid]': 'testId()',
  },
})
export class SkeletonComponent {
  // No input is `input.required`, deliberately: a required input on a nested
  // component throws NG0950 under the JIT vitest harness and takes down the
  // *host page's* entire spec (see src/testing/signal-input.ts). This component
  // renders inside LibraryComponent, ArtistDetailComponent and friends, all of
  // which have specs that render their full templates.
  readonly variant = input<SkeletonVariant>('track-row');
  /** Placeholder count. Undefined uses the variant's default; clamped 1..60. */
  readonly count = input<number | undefined>(undefined);
  /**
   * Already-translated accessible label. Non-empty makes this a live region;
   * empty (the default) makes it decorative. Only the first skeleton on a
   * screen should carry one.
   */
  readonly label = input('');
  /** Escape hatch for a list whose container differs from the variant default. */
  readonly containerClass = input('');
  /** `track-row` only: mirrors `TrackRowComponent.showCover`. */
  readonly trackCover = input(true);
  readonly testId = input<string | undefined>(undefined);

  readonly wrapperClass = computed(() =>
    skeletonContainerClass(this.variant(), this.containerClass()),
  );
  readonly items = computed(() => skeletonItems(this.variant(), this.count()));
  readonly aria = computed(() => skeletonAria(this.label()));

  /** Exposed for the template; pure so the spec can pin its determinism. */
  readonly barWidth = skeletonBarWidth;
  readonly mosaicSpot = mosaicSkeletonSpot;
}
