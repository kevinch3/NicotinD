import { describe, expect, it } from 'bun:test';
import {
  CAMELOT_WHEEL,
  MOOD_VOCAB,
  PERCEPTUAL_AXES,
  activeLibraryFilterCount,
  camelotToKeys,
  isEmptyLibraryFilter,
  parseLibraryFilter,
  serializeLibraryFilter,
  type LibraryFilter,
} from './library-filter.js';

const fullFilter: LibraryFilter = {
  bpmMin: 120,
  bpmMax: 140,
  keys: ['8A', '3B'],
  moods: ['happy', 'party'],
  buckets: { energy: ['low', 'high'], valence: ['mid'] },
  yearMin: 1990,
  yearMax: 1999,
  genres: ['Rock', 'Hip-Hop, Rap'],
  starred: true,
  durationMin: 120,
  durationMax: 360,
};

describe('serializeLibraryFilter / parseLibraryFilter', () => {
  it('round-trips every property', () => {
    expect(parseLibraryFilter(serializeLibraryFilter(fullFilter))).toEqual(fullFilter);
  });

  it('serializes to flat readable params', () => {
    const q = serializeLibraryFilter(fullFilter);
    expect(q.bpmMin).toBe('120');
    expect(q.key).toBe('8A,3B');
    expect(q.mood).toBe('happy,party');
    expect(q.energy).toBe('low,high');
    expect(q.valence).toBe('mid');
    // genre is a repeated param (free text may contain commas)
    expect(q.genre).toEqual(['Rock', 'Hip-Hop, Rap']);
    expect(q.starred).toBe('true');
    expect(q.durMin).toBe('120');
  });

  it('serializes an empty filter to no params', () => {
    expect(serializeLibraryFilter({})).toEqual({});
  });

  it('parses a single genre string as a one-element list', () => {
    expect(parseLibraryFilter({ genre: 'Rock' })).toEqual({ genres: ['Rock'] });
  });

  it('leniently drops malformed and unknown values instead of throwing', () => {
    expect(
      parseLibraryFilter({
        bpmMin: 'abc',
        bpmMax: '-5',
        key: '99Z,8A',
        mood: 'happy,confused',
        energy: 'low,extreme',
        loudness: 'high', // not a filterable axis
        yearMin: 'NaN',
        starred: 'yes',
        genre: ['', '  ', 'Rock'],
      }),
    ).toEqual({
      keys: ['8A'],
      moods: ['happy'],
      buckets: { energy: ['low'] },
      genres: ['Rock'],
    });
  });

  it('ignores unrelated query params (size, offset, type)', () => {
    expect(parseLibraryFilter({ size: '20', offset: '40', type: 'newest' })).toEqual({});
  });
});

describe('isEmptyLibraryFilter / activeLibraryFilterCount', () => {
  it('treats {} and cleared filters as empty', () => {
    expect(isEmptyLibraryFilter({})).toBe(true);
    expect(isEmptyLibraryFilter({ keys: [], genres: [], buckets: {} })).toBe(true);
    expect(isEmptyLibraryFilter({ starred: true })).toBe(false);
  });

  it('counts one per property group, one per perceptual axis', () => {
    expect(activeLibraryFilterCount({})).toBe(0);
    // bpm(1) + keys(1) + moods(1) + energy(1) + valence(1) + year(1) + genres(1) + starred(1) + duration(1)
    expect(activeLibraryFilterCount(fullFilter)).toBe(9);
    expect(activeLibraryFilterCount({ bpmMin: 100, bpmMax: 120 })).toBe(1);
  });
});

describe('CAMELOT_WHEEL / camelotToKeys', () => {
  it('has 24 unique codes covering both rings', () => {
    expect(CAMELOT_WHEEL).toHaveLength(24);
    expect(new Set(CAMELOT_WHEEL.map((e) => e.code)).size).toBe(24);
    expect(CAMELOT_WHEEL.filter((e) => e.code.endsWith('A'))).toHaveLength(12);
  });

  it('expands a code to sharp + flat spellings', () => {
    expect(camelotToKeys('8B')).toEqual(['C major']);
    expect(camelotToKeys('3B')).toEqual(['C# major', 'Db major']);
    expect(camelotToKeys('8A')).toEqual(['A minor']);
    expect(camelotToKeys('1A')).toEqual(['G# minor', 'Ab minor']);
    expect(camelotToKeys('nope')).toEqual([]);
  });
});

describe('vocab exports', () => {
  it('exposes the canonical mood vocab and perceptual axes', () => {
    expect(MOOD_VOCAB).toEqual(['happy', 'sad', 'aggressive', 'relaxed', 'party']);
    expect(PERCEPTUAL_AXES).toEqual([
      'energy',
      'danceability',
      'valence',
      'acousticness',
      'instrumental',
    ]);
  });
});
