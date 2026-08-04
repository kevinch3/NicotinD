import { describe, it, expect } from 'vitest';
import { rankPlayFromSearch } from './play-from-search';

const songs = [
  { id: '1', title: 'Second Wind', artist: 'E2E Test Artist' },
  { id: '2', title: 'Quiet Hours', artist: 'E2E Test Artist' },
  { id: '3', title: 'Wind of Change', artist: 'Scorpions' },
  { id: '4', title: 'Vientos', artist: 'Ána Tíjoux' },
];

describe('rankPlayFromSearch (Assistant voice → best library match)', () => {
  it('exact title match wins over partial matches', () => {
    expect(rankPlayFromSearch('second wind', songs)?.id).toBe('1');
  });

  it('is accent- and case-insensitive (voice transcription is unaccented)', () => {
    expect(rankPlayFromSearch('vientos ana tijoux', songs)?.id).toBe('4');
  });

  it('all query tokens present across title+artist beats a title-only prefix', () => {
    expect(rankPlayFromSearch('wind scorpions', songs)?.id).toBe('3');
  });

  it('returns null when no token matches at all', () => {
    expect(rankPlayFromSearch('completely unrelated', songs)).toBeNull();
  });

  it('empty or whitespace query matches nothing', () => {
    expect(rankPlayFromSearch('   ', songs)).toBeNull();
  });
});
