import { describe, expect, it } from 'bun:test';

import {
  gateAlbumResolution,
  gateArtistResolution,
  pickGenres,
  type MbGenre,
} from './genre-resolve.js';

const g = (name: string, count = 3): MbGenre => ({ name, count });

describe('pickGenres', () => {
  it('drops zero-count genres and orders by count', () => {
    expect(pickGenres([g('latin', 1), g('chacarera', 5), g('folk', 0)])).toEqual([
      'chacarera',
      'latin',
    ]);
  });

  it('returns nothing when MusicBrainz has no genres — the common case', () => {
    // Measured on prod: MB has genres for only 2 of 25 sampled artists. An empty
    // result must produce NO proposal at all, otherwise the review queue fills
    // with thousands of empty non-decisions.
    expect(pickGenres([])).toEqual([]);
    expect(pickGenres([g('latin', 0)])).toEqual([]);
  });

  it('caps the list so one noisy entity cannot dominate a song set', () => {
    const many = Array.from({ length: 12 }, (_, i) => g(`genre${i}`, 12 - i));
    expect(pickGenres(many)).toHaveLength(4);
  });
});

describe('gateArtistResolution', () => {
  const rgTitles = ['Herencia', 'Del sur pa allá'];

  it('auto-applies an exact name match corroborated by a shared album title', () => {
    expect(
      gateArtistResolution({
        queryName: 'José Larralde',
        candidateName: 'José Larralde',
        libraryAlbumTitles: ['Herencia'],
        releaseGroupTitles: rgTitles,
      }),
    ).toEqual({ confidence: 0.8, status: 'applied' });
  });

  it('holds an exact name match with NO corroborating album for review', () => {
    // The real false pair found while measuring #187: "Emilia" (Argentine, 26
    // songs) exact-name-matched a Swedish Emilia whose only release group is
    // "Alla mot alla" -> hip hop. Name equality alone must never auto-apply.
    expect(
      gateArtistResolution({
        queryName: 'Emilia',
        candidateName: 'Emilia',
        libraryAlbumTitles: ['.mp3', 'Perreo 420'],
        releaseGroupTitles: ['Alla mot alla'],
      }),
    ).toEqual({ confidence: 0.5, status: 'pending' });
  });

  it('holds a non-exact name match for review even when an album corroborates', () => {
    expect(
      gateArtistResolution({
        queryName: 'Larralde',
        candidateName: 'José Larralde',
        libraryAlbumTitles: ['Herencia'],
        releaseGroupTitles: rgTitles,
      }),
    ).toEqual({ confidence: 0.3, status: 'pending' });
  });

  it('ignores case, accents and punctuation when comparing', () => {
    expect(
      gateArtistResolution({
        queryName: 'jose larralde',
        candidateName: 'José Larralde',
        libraryAlbumTitles: ['herencia'],
        releaseGroupTitles: rgTitles,
      }).status,
    ).toBe('applied');
  });
});

describe('gateAlbumResolution', () => {
  it('auto-applies when both the artist and the album title match', () => {
    expect(
      gateAlbumResolution({
        queryArtist: 'Los Tetas',
        queryAlbum: 'Mama Funk',
        candidateArtist: 'Los Tetas',
        candidateAlbum: 'Mama Funk',
      }),
    ).toEqual({ confidence: 0.8, status: 'applied' });
  });

  it('holds for review when only the artist matches', () => {
    expect(
      gateAlbumResolution({
        queryArtist: 'Los Tetas',
        queryAlbum: 'Mama Funk',
        candidateArtist: 'Los Tetas',
        candidateAlbum: 'Tomala!',
      }),
    ).toEqual({ confidence: 0.5, status: 'pending' });
  });

  it('holds for review when neither matches', () => {
    expect(
      gateAlbumResolution({
        queryArtist: 'Emilia',
        queryAlbum: 'Perreo 420',
        candidateArtist: 'Emilia',
        candidateAlbum: 'Alla mot alla',
      }).status,
    ).toBe('pending');
  });
});

describe('tag-sourced ids', () => {
  it('a tag-read MBID is trusted outright', () => {
    // Nothing to gate: the file itself carries the id, so there is no matching
    // step that could pick the wrong entity.
    expect(
      gateArtistResolution({
        queryName: 'anything',
        candidateName: 'anything',
        libraryAlbumTitles: [],
        releaseGroupTitles: [],
        fromTag: true,
      }),
    ).toEqual({ confidence: 1, status: 'applied' });
  });
});
