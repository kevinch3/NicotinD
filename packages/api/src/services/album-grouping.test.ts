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

  it('folds edition qualifiers so all editions of an album share a key', () => {
    const base = normalizeForGrouping('Hot Space');
    expect(normalizeForGrouping('Hot Space (2011 Deluxe Remaster) 1')).toBe(base);
    expect(normalizeForGrouping('Hot Space (2011 Deluxe Remaster) 2')).toBe(base);
    expect(normalizeForGrouping('Hot Space - Remastered Deluxe Edition (2 CD)')).toBe(base);
    expect(normalizeForGrouping('Hot Space (Deluxe Remastered Version)')).toBe(base);
    expect(normalizeForGrouping('Are You Gonna Go My Way (20th Anniversary Deluxe Edition)')).toBe(
      normalizeForGrouping('Are You Gonna Go My Way'),
    );
    expect(normalizeForGrouping('Canción Animal (Remastered)')).toBe(
      normalizeForGrouping('Canción Animal'),
    );
    expect(normalizeForGrouping('La Pachanga (Remasterización 2022) [Explicit]')).toBe(
      normalizeForGrouping('La Pachanga'),
    );
  });

  it('strips standalone 4-digit year parentheticals added by peers to folder names', () => {
    // Peers often append release year: "Kiss Me Once (2014)" → same as "Kiss Me Once"
    expect(normalizeForGrouping('Kiss Me Once (2014)')).toBe(normalizeForGrouping('Kiss Me Once'));
    expect(normalizeForGrouping('The Abbey Road Sessions (2012)')).toBe(
      normalizeForGrouping('The Abbey Road Sessions'),
    );
    expect(normalizeForGrouping('(2014.03.14) Kylie Minogue - Kiss Me Once')).toBe(
      normalizeForGrouping('Kylie Minogue - Kiss Me Once'),
    );
  });

  it('does NOT fold genuinely distinct titles or real numbers', () => {
    expect(normalizeForGrouping('Greatest Hits')).not.toBe(normalizeForGrouping('Greatest Hits II'));
    // No edition keyword → trailing number is part of the title, kept.
    expect(normalizeForGrouping('Version 2.0')).toBe('version 2 0');
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
