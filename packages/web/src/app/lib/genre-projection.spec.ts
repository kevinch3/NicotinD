import { genresLostBy, projectGenreDistribution } from './genre-projection';
import type { GenreSlice } from '../components/genre-radar/genre-radar.component';

/**
 * Issue #222's before/after reclassification view, over the issue #260
 * append-vs-replace choice. The Ana Tijoux case is the one worth pinning: a
 * replace flattened 34 songs onto a single genre, and nothing showed that
 * before Save.
 */
const BEFORE: GenreSlice[] = [
  { genre: 'Rap', count: 30, weight: 0.88 },
  { genre: 'Hip Hop', count: 20, weight: 0.59 },
  { genre: 'Latin', count: 8, weight: 0.24 },
];
const TRACKS = 34;

describe('projectGenreDistribution', () => {
  it('replace collapses the spread onto exactly the chosen genres', () => {
    const after = projectGenreDistribution(BEFORE, ['Rap Político'], 'replace', TRACKS);
    expect(after).toEqual([{ genre: 'Rap Político', count: 34, weight: 1 }]);
  });

  it('append keeps the existing shape and raises the chosen genre to full coverage', () => {
    const after = projectGenreDistribution(BEFORE, ['Rap Político'], 'append', TRACKS);
    expect(after[0]).toEqual({ genre: 'Rap Político', count: 34, weight: 1 });
    // Everything that was there is still there, unchanged.
    expect(after.slice(1)).toEqual(BEFORE);
  });

  it('append lifts an already-present genre to full coverage rather than duplicating it', () => {
    const after = projectGenreDistribution(BEFORE, ['Rap'], 'append', TRACKS);
    expect(after.filter((s) => s.genre.toLowerCase() === 'rap')).toHaveLength(1);
    expect(after[0]).toEqual({ genre: 'Rap', count: 34, weight: 1 });
    expect(after.map((s) => s.genre)).toEqual(['Rap', 'Hip Hop', 'Latin']);
  });

  it('matches case-insensitively but keeps what the curator typed', () => {
    const after = projectGenreDistribution(BEFORE, ['rap'], 'append', TRACKS);
    expect(after.map((s) => s.genre)).toEqual(['rap', 'Hip Hop', 'Latin']);
  });

  it('de-duplicates a repeated entry', () => {
    const after = projectGenreDistribution(BEFORE, ['Folk', 'folk', ' Folk '], 'replace', TRACKS);
    expect(after).toHaveLength(1);
  });

  it('ignores blank entries from a trailing separator', () => {
    // `Folclore; ` is what a half-typed input looks like.
    expect(projectGenreDistribution(BEFORE, ['Folclore', '', '  '], 'replace', TRACKS)).toEqual([
      { genre: 'Folclore', count: 34, weight: 1 },
    ]);
  });

  it('projects an empty replace as an empty spread, not as "unchanged"', () => {
    // Honest: clearing the field really would strip every genre.
    expect(projectGenreDistribution(BEFORE, [], 'replace', TRACKS)).toEqual([]);
  });

  it('leaves the spread untouched for an empty append', () => {
    expect(projectGenreDistribution(BEFORE, [], 'append', TRACKS)).toEqual(BEFORE);
  });
});

describe('genresLostBy', () => {
  it('names what a replace would drop, in current rank order', () => {
    expect(genresLostBy(BEFORE, ['Rap'], 'replace')).toEqual(['Hip Hop', 'Latin']);
  });

  it('reports nothing lost for an append — that is its defining property', () => {
    expect(genresLostBy(BEFORE, ['Anything'], 'append')).toEqual([]);
  });

  it('reports the whole spread lost when a replace clears the field', () => {
    expect(genresLostBy(BEFORE, [], 'replace')).toEqual(['Rap', 'Hip Hop', 'Latin']);
  });
});
