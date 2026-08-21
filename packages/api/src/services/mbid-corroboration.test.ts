import { describe, expect, it } from 'bun:test';
import { foldTitle, pickByDiscographyOverlap } from './mbid-corroboration';

/**
 * Fixtures are real prod data (issue #610), captured from the kpc library and
 * the live MusicBrainz release-group endpoint, so this doubles as a replay
 * test in the spirit of album-hunter.replay.test.ts.
 */
const LIBRARY_ALBUMS = [
  'De Enero a Diciembre',
  'como si no importara',
  'rápido lento',
  'Underground',
  'Tú crees en mí?',
  'No_se_ve.mp3',
  'mp3',
  'GTA.mp3',
  'La_Original.mp3',
  'La_Playlist.mpeg',
  'pasarella 👠',
  'perfectas',
  'blackout 🧊',
  'Genio Atrapado',
];

/** MBID 1c4f6d71… — "Emilia, Swedish MC". One release group, overlapping nothing. */
const SWEDISH_MC = { mbid: 'mbid-swedish-mc', releaseGroups: ['Alla mot alla'] };

/** MBID 0d5a1ad3… — "Emilia Mernes, Argentinian singer". */
const EMILIA_MERNES = {
  mbid: 'mbid-emilia-mernes',
  releaseGroups: [
    'HISTERIQUEO',
    'La chain',
    'JETSKI (remix)',
    'Policía',
    'La_playlist.mpeg',
    'beautiful 💄',
    '.mp3',
    'Supersexi',
    'perfectas',
    'No_se_ve.mp3',
    'GTA.mp3',
    'Como si no importara',
    'BOTA',
    'Esto recién empieza',
  ],
};

describe('foldTitle', () => {
  it('folds case, accents, separators and emoji to a comparable form', () => {
    expect(foldTitle('La_Playlist.mpeg')).toBe(foldTitle('La_playlist.mpeg'));
    expect(foldTitle('como si no importara')).toBe(foldTitle('Como si no importara'));
    expect(foldTitle('.mp3')).toBe(foldTitle('mp3'));
    expect(foldTitle('pasarella 👠')).toBe('pasarella');
    expect(foldTitle('Tú crees en mí?')).toBe('tu crees en mi');
  });
});

describe('pickByDiscographyOverlap', () => {
  it('picks the candidate whose releases match the library (issue #610)', () => {
    // The shipped bug: Lidarr returned the Swedish MC first and it won on
    // name equality alone. Against the discography it has no case at all.
    expect(pickByDiscographyOverlap([SWEDISH_MC, EMILIA_MERNES], LIBRARY_ALBUMS)).toBe(
      'mbid-emilia-mernes',
    );
  });

  it('picks the right candidate regardless of the order Lidarr returned them', () => {
    expect(pickByDiscographyOverlap([EMILIA_MERNES, SWEDISH_MC], LIBRARY_ALBUMS)).toBe(
      'mbid-emilia-mernes',
    );
  });

  it('returns null when no candidate corroborates the library at all', () => {
    const unrelated = { mbid: 'mbid-other', releaseGroups: ['Something Else Entirely'] };
    expect(pickByDiscographyOverlap([SWEDISH_MC, unrelated], LIBRARY_ALBUMS)).toBeNull();
  });

  it('returns null when two candidates corroborate identically', () => {
    // A tie is still "I don't know" — picking either reintroduces the coin
    // flip this whole path exists to remove.
    const twin = { ...EMILIA_MERNES, mbid: 'mbid-twin' };
    expect(pickByDiscographyOverlap([EMILIA_MERNES, twin], LIBRARY_ALBUMS)).toBeNull();
  });

  it('does not commit on a single shared title', () => {
    // Generic release names collide across unrelated artists, and the pick is
    // cached and then feeds bio, origin, genres and artwork. One match is a
    // coincidence budget we cannot afford; a thin library stays unresolved.
    const coincidence = { mbid: 'mbid-coincidence', releaseGroups: ['perfectas'] };
    expect(pickByDiscographyOverlap([SWEDISH_MC, coincidence], LIBRARY_ALBUMS)).toBeNull();
  });

  it('commits once two titles corroborate', () => {
    const twoMatches = { mbid: 'mbid-two', releaseGroups: ['perfectas', 'GTA.mp3'] };
    expect(pickByDiscographyOverlap([SWEDISH_MC, twoMatches], LIBRARY_ALBUMS)).toBe('mbid-two');
  });

  it('returns null when there is nothing to compare against', () => {
    expect(pickByDiscographyOverlap([SWEDISH_MC, EMILIA_MERNES], [])).toBeNull();
    expect(pickByDiscographyOverlap([], LIBRARY_ALBUMS)).toBeNull();
  });
});
