import { describe, it, expect } from 'vitest';
import { baseQueries, skewedQueries, stripTitleQualifiers } from './hunt-queries';

describe('baseQueries', () => {
  it('returns the two unmodified phrasings', () => {
    expect(baseQueries('Babasonicos', 'A Proposito')).toEqual([
      'Babasonicos A Proposito',
      'Babasonicos - A Proposito',
    ]);
  });
});

describe('stripTitleQualifiers', () => {
  it('drops bracketed qualifiers', () => {
    expect(stripTitleQualifiers('Dangerous Woman (Deluxe)')).toBe('Dangerous Woman');
  });

  it('drops feat clauses', () => {
    expect(stripTitleQualifiers('Side To Side feat. Nicki Minaj')).toBe('Side To Side');
  });
});

describe('skewedQueries', () => {
  it('produces de-duped variants that exclude the base queries', () => {
    const variants = skewedQueries('Ariana Grande', 'Dangerous Woman');
    // reorder + album-only are always present
    expect(variants).toContain('Dangerous Woman Ariana Grande');
    expect(variants).toContain('Dangerous Woman');
    // never re-emits a base query
    expect(variants).not.toContain('Ariana Grande Dangerous Woman');
    expect(variants).not.toContain('Ariana Grande - Dangerous Woman');
  });

  it('drops a leading "the" from both artist and album', () => {
    const variants = skewedQueries('The Beatles', 'The White Album');
    expect(variants).toContain('Beatles White Album');
  });

  it('has no duplicate entries', () => {
    const variants = skewedQueries('Pescado Rabioso', 'Obras Cumbres');
    expect(new Set(variants).size).toBe(variants.length);
  });
});
