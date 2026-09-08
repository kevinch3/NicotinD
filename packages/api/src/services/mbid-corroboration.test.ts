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

/**
 * Issue #1008. The row prod actually held for "Gondwana" was the AUSTRALIAN
 * band — a pre-#611 pick, when `pickMbidHit` took index 0 of N same-name hits
 * and stamped 0.8 on it. The library holds the Chilean reggae band, and the
 * discography says so plainly; this fixture is the proof the tie-break was
 * never the missing piece, the re-resolution was.
 */
describe('pickByDiscographyOverlap — Gondwana (issue #1008)', () => {
  const GONDWANA_LIBRARY = ['Gondwana', 'Alabanza', 'Crece', 'Made In Jamaica'];

  /** c3af32d2… — the Chilean reggae band, release groups per the issue. */
  const GONDWANA_CL = {
    mbid: 'c3af32d2-025b-4478-9f26-8b242f4b21cc',
    releaseGroups: ['Gondwana', 'Alabanza', 'Made in Jamaica', 'Crece', 'Pincoya Calipso'],
  };

  /** 26962985… — the Australian band, the id that was cached. Its titles here
   *  stand in for a separate catalogue: the fixture's claim is the zero
   *  overlap with what the library holds, not these strings. */
  const GONDWANA_AU = {
    mbid: '26962985-3e12-4f0b-a87e-68306e08b0b5',
    releaseGroups: ['Terra Australis', 'Southern Skies'],
  };

  it('picks the Chilean band the library actually holds', () => {
    expect(pickByDiscographyOverlap([GONDWANA_AU, GONDWANA_CL], GONDWANA_LIBRARY)).toBe(
      GONDWANA_CL.mbid,
    );
  });

  it('picks it regardless of the order Lidarr returned the homonyms', () => {
    expect(pickByDiscographyOverlap([GONDWANA_CL, GONDWANA_AU], GONDWANA_LIBRARY)).toBe(
      GONDWANA_CL.mbid,
    );
  });

  it('returns null rather than the first candidate when neither corroborates', () => {
    const alsoUnrelated = { mbid: 'mbid-third-gondwana', releaseGroups: ['Something Else'] };
    expect(pickByDiscographyOverlap([GONDWANA_AU, alsoUnrelated], GONDWANA_LIBRARY)).toBeNull();
  });
});
