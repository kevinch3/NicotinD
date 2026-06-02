import { describe, expect, it } from 'bun:test';
import { albumGroupKey, normalizeForGrouping, pickCanonicalId } from './album-grouping.js';

describe('normalizeForGrouping', () => {
  it('strips diacritics and lowercases', () => {
    expect(normalizeForGrouping('Canción Animal')).toBe('cancion animal');
    expect(normalizeForGrouping('Estás liquidado')).toBe('estas liquidado');
  });

  it('collapses punctuation variants to the same value', () => {
    // The hunt produced three sibling folders differing only in punctuation.
    const a = normalizeForGrouping('¡Bang! ¡Bang! Estás liquidado');
    const b = normalizeForGrouping('¡Bang! ¡Bang!... Estás liquidado');
    const c = normalizeForGrouping('¡Bang! ¡Bang! … Estás liquidado');
    expect(a).toBe('bang bang estas liquidado');
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('keeps genuinely distinct editions separate (words differ)', () => {
    expect(normalizeForGrouping('Are You Gonna Go My Way')).not.toBe(
      normalizeForGrouping('Are You Gonna Go My Way (20th Anniversary Deluxe Edition)'),
    );
  });
});

describe('albumGroupKey', () => {
  it('keys on artist + title together', () => {
    expect(albumGroupKey('Lenny Kravitz', 'Are You Gonna Go My Way')).toBe(
      albumGroupKey('LENNY KRAVITZ', 'are you gonna go my way'),
    );
    expect(albumGroupKey('Maná', 'Amar es combatir')).not.toBe(
      albumGroupKey('Ricky Martin', 'Amar es combatir'),
    );
  });
});

describe('pickCanonicalId', () => {
  it('picks the fragment with the most songs', () => {
    expect(
      pickCanonicalId([
        { id: 'small', songCount: 3 },
        { id: 'big', songCount: 17 },
        { id: 'mid', songCount: 9 },
      ]),
    ).toBe('big');
  });

  it('breaks ties on the lexicographically smallest id (stable)', () => {
    expect(
      pickCanonicalId([
        { id: 'zzz', songCount: 5 },
        { id: 'aaa', songCount: 5 },
      ]),
    ).toBe('aaa');
  });
});
