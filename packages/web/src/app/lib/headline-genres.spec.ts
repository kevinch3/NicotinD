import { headlineGenres } from './headline-genres';

describe('headlineGenres (#1572)', () => {
  it('returns null with no genre data', () => {
    expect(headlineGenres([])).toBeNull();
    expect(headlineGenres([{ genre: 'Other', weight: 1 }])).toBeNull();
  });

  it('names one genre when it covers at least 60%', () => {
    expect(
      headlineGenres([
        { genre: 'Rock', weight: 0.2 },
        { genre: 'Pop', weight: 0.6 },
        { genre: 'Other', weight: 0.2 },
      ]),
    ).toEqual({ kind: 'single', genres: ['Pop'] });
  });

  it('names two genres when together they cover at least 70% and the second is at least 20%', () => {
    expect(
      headlineGenres([
        { genre: 'Pop', weight: 0.48 },
        { genre: 'Salsa', weight: 0.3 },
        { genre: 'Other', weight: 0.22 },
      ]),
    ).toEqual({ kind: 'pair', genres: ['Pop', 'Salsa'] });
  });

  it('does not promote a stray second genre into a pair', () => {
    expect(
      headlineGenres([
        { genre: 'Pop', weight: 0.55 },
        { genre: 'Salsa', weight: 0.15 },
        { genre: 'Ballad', weight: 0.15 },
        { genre: 'Other', weight: 0.15 },
      ])?.kind,
    ).toBe('mixed');
  });

  it('calls a spread catalogue mixed, keeping the top three (ties by name)', () => {
    expect(
      headlineGenres([
        { genre: 'Rock', weight: 0.3 },
        { genre: 'Pop', weight: 0.3 },
        { genre: 'Jazz', weight: 0.2 },
        { genre: 'Folk', weight: 0.2 },
      ]),
    ).toEqual({ kind: 'mixed', genres: ['Pop', 'Rock', 'Folk'] });
  });

  it('never headlines the "Other" fold even when it is the largest', () => {
    expect(
      headlineGenres([
        { genre: 'Other', weight: 0.7 },
        { genre: 'Pop', weight: 0.3 },
      ]),
    ).toEqual({ kind: 'mixed', genres: ['Pop'] });
  });
});
