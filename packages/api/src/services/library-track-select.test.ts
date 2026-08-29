import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  LOSSLESS,
  formatQuality,
  losslessSuffixSql,
  selectAlbumTracks,
  type SelectableTrack,
} from './library-track-select.js';

function t(relPath: string, title: string, suffix: string, bitRate = 320): SelectableTrack {
  return { relPath, title, suffix, bitRate };
}

describe('formatQuality', () => {
  it('ranks lossless above any lossy regardless of bitrate', () => {
    expect(formatQuality('flac', 900)).toBeGreaterThan(formatQuality('mp3', 320));
    expect(formatQuality('wav', 1)).toBeGreaterThan(formatQuality('m4a', 256));
  });
  it('breaks ties within a tier by bitrate', () => {
    expect(formatQuality('mp3', 320)).toBeGreaterThan(formatQuality('mp3', 128));
  });
});

describe('selectAlbumTracks — without a canonical list', () => {
  it('collapses format-duplicates of the same title to the best copy', () => {
    const kept = selectAlbumTracks([
      t('01 - Song.mp3', 'Song', 'mp3'),
      t('01 - Song.flac', 'Song', 'flac'),
      t('02 - Other.m4a', 'Other', 'm4a'),
    ]);
    expect(kept.map((k) => k.relPath).sort()).toEqual(['01 - Song.flac', '02 - Other.m4a']);
  });

  it('keeps distinct titles and does NOT drop anything as foreign', () => {
    const kept = selectAlbumTracks([t('a.mp3', 'A', 'mp3'), t('b.mp3', 'B', 'mp3')]);
    expect(kept).toHaveLength(2);
  });

  it('is deterministic: equal-quality duplicates keep the lexicographically smallest path', () => {
    const kept = selectAlbumTracks([
      t('z - Song.mp3', 'Song', 'mp3'),
      t('a - Song.mp3', 'Song', 'mp3'),
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.relPath).toBe('a - Song.mp3');
  });
});

describe('selectAlbumTracks — with a canonical Lidarr tracklist', () => {
  // The real "A propósito" case: a folder mixing flac + mp3 + m4a, with foreign
  // tracks (Pulpito / Parte 1 El Sultán / Parte 2 Jaula) that aren't in the album.
  const canonical = [
    'Flora y Fauno',
    'Fiesta popular',
    'Tormento',
    'Deshoras',
    'Ideas',
    'En privado',
    'Muñeco de Haiti',
    'El pupilo',
    'Barranca abajo',
    'Chisme de zorro',
  ];

  const files = [
    t('01 - Flora y Fauno.flac', 'Flora y Fauno', 'flac'),
    t('01 - Flora y Fauno.mp3', 'Flora y Fauno', 'mp3'),
    t('03 - Tormento.m4a', 'Tormento', 'm4a'),
    t('04 - Deshoras.mp3', 'Deshoras', 'mp3'),
    t('05 - Ideas.mp3', 'Ideas', 'mp3'),
    t('05 - Pulpito.m4a', 'Pulpito', 'm4a'), // foreign
    t('07 - Muñeco de Haiti.flac', 'Muñeco de Haiti', 'flac'),
    t('08 - Muñeco de Haití.m4a', 'Muñeco de Haití', 'm4a'), // dup of t7 (accent) → collapses
    t('09 - Parte 1 El Sultán.m4a', 'Parte 1: El Sultán', 'm4a'), // foreign
    t('10 - Parte 2 Jaula.m4a', 'Parte 2: Jaula', 'm4a'), // foreign
  ];

  it('drops foreign tracks and keeps one best copy per canonical track', () => {
    const kept = selectAlbumTracks(files, canonical)
      .map((k) => k.relPath)
      .sort();
    expect(kept).toEqual(
      [
        '01 - Flora y Fauno.flac', // flac beats mp3
        '03 - Tormento.m4a',
        '04 - Deshoras.mp3',
        '05 - Ideas.mp3',
        '07 - Muñeco de Haiti.flac', // flac beats the accented m4a dup
      ].sort(),
    );
  });

  it('excludes every foreign file (Pulpito / El Sultán / Jaula)', () => {
    const kept = selectAlbumTracks(files, canonical).map((k) => k.relPath);
    expect(kept).not.toContain('05 - Pulpito.m4a');
    expect(kept).not.toContain('09 - Parte 1 El Sultán.m4a');
    expect(kept).not.toContain('10 - Parte 2 Jaula.m4a');
  });

  it('matches diacritic variants (Haiti / Haití) as the same canonical track', () => {
    const kept = selectAlbumTracks(
      [t('a.m4a', 'Muñeco de Haití', 'm4a'), t('b.flac', 'Muneco de Haiti', 'flac')],
      ['Muñeco de Haiti'],
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]!.relPath).toBe('b.flac');
  });
});

describe('losslessSuffixSql', () => {
  it('matches exactly the lossless suffixes, case-insensitive, NULL-safe', () => {
    const db = new Database(':memory:');
    db.run('CREATE TABLE f (suffix TEXT)');
    for (const s of ['flac', 'FLAC', 'wav', 'ape', 'mp3', 'opus', null]) {
      db.run('INSERT INTO f (suffix) VALUES (?)', [s]);
    }
    const n = db
      .query<{ c: number }, []>(`SELECT COUNT(*) c FROM f WHERE ${losslessSuffixSql('suffix')}`)
      .get()?.c;
    expect(n).toBe(4);
  });

  it('derives from LOSSLESS so the TS set and the SQL cannot drift', () => {
    const sql = losslessSuffixSql('x');
    for (const s of LOSSLESS) expect(sql).toContain(`'${s}'`);
  });
});

// Issue #776: a curator's title correction must not be mistaken for a foreign
// rip. `titlesOverlap` asks how many of the CANONICAL words survive in the
// file's title, so *removing* words (which is exactly what a cleanup does)
// drops the ratio below 0.7 and the file was discarded from the scan — never
// reaching persist, so library_songs kept the pre-edit title forever. Real
// prod case: Juanes — Un Día Normal (20th Anniversary), 2026-08-27.
describe('selectAlbumTracks — canonical governs admission, not retention', () => {
  const JUANES_CANONICAL = [
    'A Dios Le Pido (Remastered 2022)',
    'Es Por Tí (Remastered 2022)',
    'Un Día Normal (Remastered 2022)',
  ];

  it('drops a retagged file that is NOT already in the library (unchanged ingest behaviour)', () => {
    const kept = selectAlbumTracks(
      [t('02 - Es Por Ti.opus', 'Es Por Ti', 'opus', 200)],
      JUANES_CANONICAL,
    );
    expect(kept).toEqual([]);
  });

  it('keeps a retagged file the library already holds, so the edit reaches persist', () => {
    const track = t('02 - Es Por Ti (Remastered 2022).opus', 'Es Por Ti', 'opus', 200);
    const kept = selectAlbumTracks([track], JUANES_CANONICAL, new Set([track.relPath]));
    expect(kept.map((k) => k.title)).toEqual(['Es Por Ti']);
  });

  it('still drops a genuinely foreign rip that the library does not hold', () => {
    const known = t('01 - A Dios Le Pido.opus', 'A Dios Le Pido', 'opus', 200);
    const foreign = t('99 - Some Other Band - Filler.mp3', 'Some Other Band Filler', 'mp3', 320);
    const kept = selectAlbumTracks([known, foreign], JUANES_CANONICAL, new Set([known.relPath]));
    expect(kept.map((k) => k.relPath)).toEqual([known.relPath]);
  });

  it('still collapses format-duplicates of a known retagged track to the best copy', () => {
    const flac = t('02 - Es Por Ti.flac', 'Es Por Ti', 'flac', 900);
    const opus = t('02 - Es Por Ti.opus', 'Es Por Ti', 'opus', 200);
    const kept = selectAlbumTracks(
      [opus, flac],
      JUANES_CANONICAL,
      new Set([flac.relPath, opus.relPath]),
    );
    expect(kept.map((k) => k.suffix)).toEqual(['flac']);
  });
});
