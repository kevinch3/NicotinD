import { describe, expect, it } from 'bun:test';
import { normalizeTitle, titlesOverlap } from './title-match.js';

describe('normalizeTitle', () => {
  it('folds accents, strips track numbers and punctuation', () => {
    expect(normalizeTitle('03 - Canción de Amor!')).toBe('cancion de amor');
    expect(normalizeTitle('  Weird   spacing ')).toBe('weird spacing');
  });
});

describe('titlesOverlap', () => {
  it('accepts an exact match and a 70% word overlap', () => {
    expect(titlesOverlap('cancion de amor', 'cancion de amor')).toBe(true);
    expect(titlesOverlap('cancion de amor', 'cancion de amor remaster')).toBe(true);
  });

  it('rejects a weak overlap and an empty canonical', () => {
    expect(titlesOverlap('cancion de amor', 'something else entirely')).toBe(false);
    expect(titlesOverlap('', 'x')).toBe(false);
  });
});
