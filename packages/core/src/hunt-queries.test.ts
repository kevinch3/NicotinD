import { describe, it, expect } from 'bun:test';
import {
  fold,
  stripTitleQualifiers,
  stripPunctuation,
  distinctiveTokens,
  baseQueries,
  buildSkewedQueries,
  skewedQueries,
  buildTrackQueries,
} from './hunt-queries.js';

describe('primitives', () => {
  it('fold strips diacritics and lowercases', () => {
    expect(fold('Beyoncé')).toBe('beyonce');
    expect(fold('Sigur Rós')).toBe('sigur ros');
  });

  it('stripPunctuation spaces punctuation, expands &, drops apostrophes', () => {
    expect(stripPunctuation("Guns N' Roses")).toBe('Guns N Roses');
    expect(stripPunctuation('Simon & Garfunkel')).toBe('Simon and Garfunkel');
    expect(stripPunctuation('AC/DC')).toBe('AC DC');
  });

  it('distinctiveTokens drops filler words, keeps identifying ones + casing', () => {
    expect(distinctiveTokens('Pink Floyd The Dark Side of the Moon')).toBe(
      'Pink Floyd Dark Side Moon',
    );
    expect(distinctiveTokens('La Bifurcada')).toBe('Bifurcada'); // "La" is a stopword
  });

  it('stripTitleQualifiers removes bracketed + feat clauses', () => {
    expect(stripTitleQualifiers('Stay (feat. Justin Bieber)')).toBe('Stay');
    expect(stripTitleQualifiers('Halo (2024 Remaster)')).toBe('Halo');
  });
});

describe('buildSkewedQueries', () => {
  const skew = (a: string, b: string) => buildSkewedQueries(a, b, baseQueries(a, b));

  it('plain ASCII input drops the redundant/imprecise variants (no char-drop)', () => {
    // fold/punctuation/drop-the all collapse to a base for plain input; the old
    // "Artis Album" / "Artis - Album" last-char hack is gone entirely.
    expect(skew('Artist', 'Album')).toEqual(['Album Artist', 'Album']);
  });

  it('adds an accent-folded variant for an accented name', () => {
    expect(skew('Beyoncé', 'Lemonade')).toContain('beyonce lemonade');
  });

  it('adds a punctuation-stripped + distinctive-token variant', () => {
    const out = skew('AC/DC', 'Back in Black');
    expect(out).toContain('AC DC Back in Black'); // punctuation stripped
    expect(out).toContain('AC/DC Back Black'); // distinctive tokens ("in" dropped)
  });

  it('keeps the qualifier-stripped core for singles + drops leading "the"', () => {
    const out = skew('Pink Floyd', 'The Dark Side of the Moon');
    expect(out).toContain('Pink Floyd Dark Side Moon'); // distinctive
    expect(out).toContain('Pink Floyd Dark Side of the Moon'); // drop-the
  });

  it('never re-emits a base query and has no duplicates', () => {
    const out = skew('Bajofondo', 'Presente');
    const base = baseQueries('Bajofondo', 'Presente').map((q) => q.toLowerCase());
    for (const q of out) expect(base).not.toContain(q.toLowerCase());
    expect(new Set(out.map((q) => q.toLowerCase())).size).toBe(out.length);
  });

  it('skewedQueries is buildSkewedQueries against the standard base', () => {
    expect(skewedQueries('Artist', 'Album')).toEqual(
      buildSkewedQueries('Artist', 'Album', baseQueries('Artist', 'Album')),
    );
  });
});

describe('buildTrackQueries', () => {
  it('leads with the exact phrase then faithful variants (no char-drop)', () => {
    const out = buildTrackQueries('Beyoncé', 'Halo');
    expect(out[0]).toBe('Beyoncé Halo');
    expect(out).toContain('beyonce halo'); // accent-folded
    expect(out).toContain('Halo'); // title only
    expect(out).not.toContain('Beyonc Halo'); // old last-char hack gone
  });

  it('adds a qualifier-stripped variant for a (feat …) title', () => {
    const out = buildTrackQueries('Artist', 'Song (feat. X)');
    expect(out).toContain('Artist Song'); // qualifier stripped
    expect(out).toContain('Artist Song feat X'); // punctuation stripped
  });
});
