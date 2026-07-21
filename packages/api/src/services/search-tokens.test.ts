import { describe, it, expect } from 'bun:test';
import { fold, tokenize, matchesAllTokens } from './search-tokens';

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
