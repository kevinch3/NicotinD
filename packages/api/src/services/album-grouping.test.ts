import { describe, expect, it } from 'bun:test';
import {
  albumGroupKey,
  normalizeArtistForGrouping,
  normalizeForGrouping,
  pickCanonicalId,
} from './album-grouping.js';

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
    expect(normalizeForGrouping('Greatest Hits')).not.toBe(
      normalizeForGrouping('Greatest Hits II'),
    );
    // No edition keyword → trailing number is part of the title, kept.
    expect(normalizeForGrouping('Version 2.0')).toBe('version 2 0');
  });
});

describe('normalizeArtistForGrouping', () => {
  it('treats artists differing only by punctuation as distinct', () => {
    // "Miranda!" and "Miranda" are different artists.
    expect(normalizeArtistForGrouping('Miranda!')).not.toBe(normalizeArtistForGrouping('Miranda'));
    expect(normalizeArtistForGrouping('Panic! at the Disco')).not.toBe(
      normalizeArtistForGrouping('Panic at the Disco'),
    );
  });

  it('strips diacritics and lowercases', () => {
    expect(normalizeArtistForGrouping('Björk')).toBe('bjork');
    expect(normalizeArtistForGrouping('MIRANDA!')).toBe('miranda!');
  });

  it('collapses extra whitespace', () => {
    expect(normalizeArtistForGrouping('  The   Beatles  ')).toBe('the beatles');
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

describe('normalizeForGrouping — non-Latin scripts', () => {
  it('keeps non-Latin titles distinct instead of collapsing them to ""', () => {
    // `[^a-z0-9]` is ASCII-only, so every Cyrillic/CJK/Hangul/Arabic title
    // normalized to the empty string — and the key is sha1'd into the album id,
    // so two records by one artist collapsed into a single row.
    const titles = ['Группа крови', 'Ночь', '東京事変', '教育', '방탄소년단', 'أم كلثوم'];
    const keys = titles.map(normalizeForGrouping);
    expect(keys).not.toContain('');
    expect(new Set(keys).size).toBe(titles.length);
  });

  it('gives one artist two distinct album ids for two non-Latin releases', () => {
    expect(albumGroupKey('Кино', 'Ночь')).not.toBe(albumGroupKey('Кино', 'Группа крови'));
  });

  it('keeps a base letter that carries no combining mark (Turkish dotless ı)', () => {
    // "Şımarık": Ş decomposes to S + cedilla, but ı (U+0131) is its own base
    // letter — the ASCII strip deleted it outright, yielding "s mar k".
    expect(normalizeForGrouping('Şımarık')).toBe('sımarık');
  });

  it('still folds diacritics and strips editions for Latin titles', () => {
    // Guard: the Unicode-aware strip must not regress the existing contract.
    expect(normalizeForGrouping('Canción Animal (Remastered)')).toBe('cancion animal');
    expect(normalizeForGrouping('¡Bang! ¡Bang!... Estás liquidado')).toBe(
      'bang bang estas liquidado',
    );
  });
});
