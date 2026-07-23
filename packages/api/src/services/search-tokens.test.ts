import { describe, it, expect } from 'bun:test';
import { fold, tokenize, matchesAllTokens, rankBy } from './search-tokens';

describe('fold', () => {
  it('strips diacritics and lowercases', () => {
    expect(fold('Ídolo')).toBe('idolo');
    expect(fold('niño')).toBe('nino');
    expect(fold('São Paulo')).toBe('sao paulo');
  });

  it('preserves non-Latin base letters', () => {
    expect(fold('Мир')).toBe('мир');
  });
});

describe('tokenize', () => {
  it('splits on any non-alphanumeric boundary and folds', () => {
    expect(tokenize('C. Tangana Ídolo')).toEqual(['c', 'tangana', 'idolo']);
  });

  it('drops empty tokens from punctuation runs', () => {
    expect(tokenize('  la -- bifurcada  ')).toEqual(['la', 'bifurcada']);
  });
});

describe('matchesAllTokens', () => {
  it('requires every token (AND semantics)', () => {
    const tokens = tokenize('la bifurcada');
    expect(matchesAllTokens('La Bifurcada — Bajofondo', tokens)).toBe(true);
    expect(matchesAllTokens('LA — Teddy Thompson', tokens)).toBe(false);
  });

  it('matches accent-insensitively', () => {
    expect(matchesAllTokens('Ídolo', tokenize('idolo'))).toBe(true);
  });
});

describe('rankBy', () => {
  it('ranks exact match, then full-query prefix, then first-token prefix, then alphabetical', () => {
    const tokens = tokenize('la bifurcada');
    const rows = [
      'La Bifurcada Extended', // full-query prefix
      'Zzz Song', // no match at all (still sorted, just last)
      'La Bifurcada', // exact match
      'La — Something Else', // first-token prefix only
      'Aaa Song',
    ];
    const sorted = [...rows].sort(rankBy(tokens, (r) => r));
    expect(sorted).toEqual([
      'La Bifurcada',
      'La Bifurcada Extended',
      'La — Something Else',
      'Aaa Song',
      'Zzz Song',
    ]);
  });

  it('falls back to alphabetical for rows in the same tier', () => {
    const tokens = tokenize('rock');
    const rows = ['Rock B', 'Rock A'];
    const sorted = [...rows].sort(rankBy(tokens, (r) => r));
    expect(sorted).toEqual(['Rock A', 'Rock B']);
  });
});
