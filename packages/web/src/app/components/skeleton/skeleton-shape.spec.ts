import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { skeletonContainerClass, type SkeletonVariant } from './skeleton.component';

/**
 * Drift guard for the shape-match contract.
 *
 * A skeleton only earns its keep if it occupies the *same box* as the list it
 * stands in for — otherwise the layout still jumps on arrival and we have
 * traded a spinner for a slower spinner. That contract lives in two places at
 * once: the container string in `skeleton.component.ts` and the real grid in a
 * page template. Nothing but this file stops the page from being re-tuned
 * (a column added, a gap widened) while the skeleton keeps the old geometry.
 *
 * Same idiom as `pages/page-shell.spec.ts`: read the template off disk and
 * assert the literal appears. Like that guard, `toContain` is **class-order
 * sensitive** — a semantically-equivalent reorder of the same classes would
 * slip past. These are canaries for the idiomatic spelling, not proofs.
 */
const read = (rel: string): string => readFileSync(join(__dirname, '../..', rel), 'utf8');

/** variant → a page that renders the real list this variant mirrors. */
const MIRRORS: Array<[SkeletonVariant, string]> = [
  ['album-tile', 'pages/library/library.component.html'],
  ['artist-tile', 'pages/library/library.component.html'],
  ['genre-tile', 'pages/library/library.component.html'],
  ['album-tile', 'pages/library/library-find.component.html'],
];

describe('skeleton shape matches the real list', () => {
  it.each(MIRRORS)('%s container still appears in %s', (variant, page) => {
    expect(read(page)).toContain(skeletonContainerClass(variant));
  });

  // track-row's container is the stack spacing every song listing uses. The
  // variant string carries a leading `block` because the host element is the
  // container and an unknown element is inline by default, so compare on the
  // spacing class rather than the whole string.
  it.each([
    'pages/library/artist-detail.component.html',
    'pages/library/library-songs.component.html',
    'pages/library/playlist-detail.component.html',
    'pages/library/library-find.component.html',
  ])('track-row stack spacing still matches %s', (page) => {
    expect(skeletonContainerClass('track-row')).toContain('space-y-0.5');
    expect(read(page)).toContain('space-y-0.5');
  });

  it('shelf-tile container still matches the recently-played shelf', () => {
    // Inline template, so the "page" here is the component file itself.
    expect(read('components/recently-played/recently-played.component.ts')).toContain(
      skeletonContainerClass('shelf-tile'),
    );
  });

  it('detail-header container still matches the album page header', () => {
    expect(read('pages/library/album-detail.component.html')).toContain(
      skeletonContainerClass('detail-header'),
    );
  });

  it('artist-header container still matches the artist page header', () => {
    expect(read('pages/library/artist-detail.component.html')).toContain(
      skeletonContainerClass('artist-header'),
    );
  });

  // search's catalog grid is a narrower column scale than the library's, which
  // is the one call site that must pass `containerClass`. If the page and the
  // override drift apart the skeleton silently mis-sizes, so pin both halves.
  it('search passes an override matching its own catalog grid', () => {
    const page = read('pages/search/search.component.html');
    const catalogGrid = 'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3';
    expect(page).toContain(catalogGrid);
    expect(page).toContain(`containerClass="${catalogGrid}"`);
  });
});
