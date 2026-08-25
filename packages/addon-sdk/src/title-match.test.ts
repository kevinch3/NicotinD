import { describe, expect, it } from 'bun:test';
import { normalizeTitle, titlesOverlap } from './title-match.js';

describe('normalizeTitle', () => {
  it('folds accents, strips track numbers and punctuation', () => {
    expect(normalizeTitle('03 - Canción de Amor!')).toBe('cancion de amor');
    expect(normalizeTitle('  Weird   spacing ')).toBe('weird spacing');
  });

  it('keeps non-Latin titles distinct instead of collapsing them to ""', () => {
    // `\w` is ASCII-only, so every Cyrillic/CJK/Hangul/Arabic title normalized
    // to "" — which made `titlesOverlap` return true for every pair of them.
    const titles = ['Группа крови', 'Ночь', '東京事変', '教育', '방탄소년단', 'أم كلثوم'];
    const normalized = titles.map(normalizeTitle);
    expect(normalized).not.toContain('');
    expect(new Set(normalized).size).toBe(titles.length);
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

  it('does not match two unrelated non-Latin titles', () => {
    // Both normalized to "", so the `canonical === filename` fast path made
    // every pair of non-Latin titles "the same track".
    expect(titlesOverlap(normalizeTitle('Ночь'), normalizeTitle('Группа крови'))).toBe(false);
  });
});
