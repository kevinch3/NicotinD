import { describe, it, expect } from 'bun:test';
import {
  fold,
  stripTitleQualifiers,
  wildcardWord,
  wildcardPhrase,
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

  it('wildcardWord masks the first letter of a name', () => {
    expect(wildcardWord('Gorillaz')).toBe('*orillaz');
    expect(wildcardWord('Beyoncé')).toBe('*eyoncé');
  });

  it('wildcardWord leaves short words, filler and non-letter starts alone', () => {
    expect(wildcardWord('U2')).toBe('U2');
    expect(wildcardWord('Yes')).toBe('Yes');
    expect(wildcardWord('The')).toBe('The');
    expect(wildcardWord('from')).toBe('from');
    expect(wildcardWord('(Blue')).toBe('(Blue');
    expect(wildcardWord('2Pac')).toBe('2Pac');
  });

  it('wildcardPhrase masks only the artist words when given one, every word otherwise', () => {
    expect(wildcardPhrase('Gorillaz Demon Days', 'Gorillaz')).toBe('*orillaz Demon Days');
    expect(wildcardPhrase('Gorillaz Demon Days')).toBe('*orillaz *emon *ays');
    expect(wildcardPhrase('The Beatles Abbey Road', 'The Beatles')).toBe('The *eatles Abbey Road');
  });

  it('stripTitleQualifiers removes bracketed + feat clauses', () => {
    expect(stripTitleQualifiers('Stay (feat. Justin Bieber)')).toBe('Stay');
    expect(stripTitleQualifiers('Halo (2024 Remaster)')).toBe('Halo');
  });
});

describe('buildSkewedQueries', () => {
  const skew = (a: string, b: string) => buildSkewedQueries(a, b, baseQueries(a, b));

  // Measured on prod 2026-11-13: every query carrying "gorillaz" got 0 responses
  // (9 of 9), while "*orillaz *orillaz" reached 238 peers.
  it('a self-titled album gets one query, free of the bare artist word', () => {
    expect(skew('Gorillaz', 'Gorillaz')).toEqual(['*orillaz *orillaz']);
  });

  it('wildcards the artist words first, then every word', () => {
    expect(skew('Gorillaz', 'Demon Days')).toEqual(['*orillaz Demon Days', '*orillaz *emon *ays']);
  });

  it('adds the qualifier-stripped title a peer folder often carries', () => {
    expect(skew('Weezer', 'Weezer (Blue Album)')).toEqual([
      '*eezer *eezer (Blue Album)',
      '*eezer *eezer (Blue *lbum)',
      '*eezer *eezer',
    ]);
  });

  it('an artist and album with no word worth wildcarding get no retry', () => {
    expect(skew('U2', 'War')).toEqual([]);
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
  it('leads with the exact phrase, then the wildcarded retries', () => {
    expect(buildTrackQueries('Gorillaz', 'Clint Eastwood')).toEqual([
      'Gorillaz Clint Eastwood',
      '*orillaz Clint Eastwood',
      '*orillaz *lint *astwood',
    ]);
  });

  it('adds the qualifier-stripped title for a (feat …) title', () => {
    const out = buildTrackQueries('Artist', 'Song (feat. X)');
    expect(out[0]).toBe('Artist Song (feat. X)');
    expect(out).toContain('Artist Song');
    expect(out).toContain('*rtist Song');
  });

  it('a phrase with nothing to wildcard is the exact query alone', () => {
    expect(buildTrackQueries('U2', 'One')).toEqual(['U2 One']);
  });
});
