import { describe, it, expect } from 'vitest';
import type { MetadataCandidate } from '../../types/core';
import { defaultQuery, candidateToRequest, manualToRequest, isPlaceholderArtist } from './metadata-fix';

describe('defaultQuery', () => {
  it('joins artist and album', () => {
    expect(defaultQuery('La Portuaria', 'Selva')).toBe('La Portuaria Selva');
  });
  it('drops a placeholder artist and searches by album only', () => {
    expect(defaultQuery('<Desconocido>', 'Selva')).toBe('Selva');
  });
});

describe('isPlaceholderArtist', () => {
  it('flags bracketed / unknown placeholders', () => {
    for (const n of ['<Desconocido>', 'Unknown Artist', 'Various Artists', '']) {
      expect(isPlaceholderArtist(n)).toBe(true);
    }
  });
  it('passes a real band through', () => {
    expect(isPlaceholderArtist('La Portuaria')).toBe(false);
  });
});

describe('candidateToRequest', () => {
  it('adopts every field from a Lidarr candidate', () => {
    const c: MetadataCandidate = {
      releaseGroupId: 'mb-1',
      artist: 'La Portuaria',
      title: 'Selva',
      year: 1996,
      releaseType: 'album',
      coverUrl: 'http://img/x.jpg',
      score: 100,
    };
    expect(candidateToRequest(c)).toEqual({
      artist: 'La Portuaria',
      album: 'Selva',
      year: 1996,
      coverUrl: 'http://img/x.jpg',
      releaseType: 'album',
      source: 'lidarr',
    });
  });

  it('drops null/empty optionals', () => {
    const c: MetadataCandidate = {
      releaseGroupId: null,
      artist: 'A',
      title: 'B',
      year: null,
      releaseType: null,
      coverUrl: null,
      score: 50,
    };
    expect(candidateToRequest(c)).toEqual({
      artist: 'A',
      album: 'B',
      year: undefined,
      coverUrl: undefined,
      releaseType: undefined,
      source: 'lidarr',
    });
  });
});

describe('manualToRequest', () => {
  it('builds a request from free-text, parsing the year', () => {
    expect(manualToRequest({ artist: ' La Portuaria ', album: 'Selva', year: '1996' })).toEqual({
      artist: 'La Portuaria',
      album: 'Selva',
      year: 1996,
      source: 'manual',
    });
  });

  it('returns null when everything is blank', () => {
    expect(manualToRequest({ artist: '  ', album: '', year: '' })).toBeNull();
  });

  it('ignores a non-numeric year', () => {
    expect(manualToRequest({ artist: 'A', year: 'abc' })).toEqual({
      artist: 'A',
      album: undefined,
      year: undefined,
      source: 'manual',
    });
  });
});
