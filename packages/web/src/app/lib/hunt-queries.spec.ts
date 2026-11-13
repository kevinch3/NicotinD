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
  it('wildcards the artist words, then every word, and excludes the base queries', () => {
    const variants = skewedQueries('Ariana Grande', 'Dangerous Woman');
    expect(variants).toEqual(['*riana *rande Dangerous Woman', '*riana *rande *angerous *oman']);
    expect(variants).not.toContain('Ariana Grande Dangerous Woman');
  });

  it('leaves filler words literal', () => {
    expect(skewedQueries('The Beatles', 'The White Album')[0]).toBe('The *eatles The White Album');
  });

  it('has no duplicate entries', () => {
    const variants = skewedQueries('Pescado Rabioso', 'Obras Cumbres');
    expect(new Set(variants).size).toBe(variants.length);
  });
});
