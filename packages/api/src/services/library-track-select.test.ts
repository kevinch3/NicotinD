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

/**
 * Issue #747. Within an album a track was identified by its normalized TITLE
 * alone, while album identity correctly collapses every disc into one row. So a
 * release that legitimately repeats a title across discs — an interlude, a
 * reprise, "Intro" on both halves — collapsed two real files to one key and the
 * loser was dropped at selection time. It never became a `library_songs` row at
 * all, and no report surfaced it: `/api/library/untracked` is about
 * `relative_path IS NULL` acquisitions, a different thing.
 */
describe('selectAlbumTracks — a title repeated across discs', () => {
  const d = (
    relPath: string,
    title: string,
    disc: number | null,
    suffix = 'flac',
  ): SelectableTrack => ({ relPath, title, suffix, bitRate: 900, disc });

  it('keeps both files when one title appears on two discs', () => {
    const kept = selectAlbumTracks([
      d('CD1/01 - Intro.flac', 'Intro', 1),
      d('CD2/01 - Intro.flac', 'Intro', 2),
    ]);
    expect(kept.map((k) => k.relPath).sort()).toEqual([
      'CD1/01 - Intro.flac',
      'CD2/01 - Intro.flac',
    ]);
  });

  it('still collapses format-duplicates WITHIN one disc', () => {
    // The whole point of selection: disc must add a dimension, not disable it.
    const kept = selectAlbumTracks([
      d('CD1/01 - Intro.mp3', 'Intro', 1, 'mp3'),
      d('CD1/01 - Intro.flac', 'Intro', 1),
    ]);
    expect(kept.map((k) => k.relPath)).toEqual(['CD1/01 - Intro.flac']);
  });

  it('treats an untagged disc as disc 1, so a partly-tagged album still collapses', () => {
    const kept = selectAlbumTracks([
      d('01 - Intro.mp3', 'Intro', null, 'mp3'),
      d('01 - Intro.flac', 'Intro', 1),
    ]);
    expect(kept.map((k) => k.relPath)).toEqual(['01 - Intro.flac']);
  });

  it('keeps both under a canonical tracklist that names the title twice', () => {
    // Lidarr's canonical list is titles only, so both discs' "Intro" match the
    // same entry; without a disc term `canon.find` returns the first for both.
    const kept = selectAlbumTracks(
      [d('CD1/01 - Intro.flac', 'Intro', 1), d('CD2/01 - Intro.flac', 'Intro', 2)],
      ['Intro', 'Intro', 'Closer'],
    );
    expect(kept).toHaveLength(2);
  });

  it('keeps an unnamed multi-disc track in its own disc slot (#968)', () => {
    // Disc-awareness must not collapse a track the tracklist does not name into
    // another disc's entry — it keys by (disc, its own title) and survives.
    const kept = selectAlbumTracks(
      [d('CD1/01 - Intro.flac', 'Intro', 1), d('CD2/99 - Bonus Advert.flac', 'Bonus Advert', 2)],
      ['Intro'],
    );
    expect(kept.map((k) => k.relPath).sort()).toEqual(
      ['CD1/01 - Intro.flac', 'CD2/99 - Bonus Advert.flac'].sort(),
    );
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

  it('keeps one best copy per canonical track', () => {
    const kept = selectAlbumTracks(files, canonical).map((k) => k.relPath);
    expect(kept).toContain('01 - Flora y Fauno.flac'); // flac beats mp3
    expect(kept).not.toContain('01 - Flora y Fauno.mp3');
    expect(kept).toContain('07 - Muñeco de Haiti.flac'); // flac beats the accented m4a dup
    expect(kept).not.toContain('08 - Muñeco de Haití.m4a');
  });

  it('retains the unnamed files rather than deleting them (#968)', () => {
    // Deliberate trade-off, chosen 2026-09-07 after prod measurement: the
    // tracklist no longer deletes a file it does not name, so a genuinely
    // foreign rip in a mixed folder now shows up in the album. That is the
    // price of never losing a real track to a tracklist pinned from a
    // different edition — which cost 121 unreachable tracks on prod, against
    // 1 dropped file whose artist tag actually disagreed with the album.
    const kept = selectAlbumTracks(files, canonical).map((k) => k.relPath);
    expect(kept).toContain('05 - Pulpito.m4a');
    expect(kept).toContain('09 - Parte 1 El Sultán.m4a');
    expect(kept).toContain('10 - Parte 2 Jaula.m4a');
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

  it('keeps a retagged file that is NOT yet in the library (#968 reversed this)', () => {
    // This assertion used to expect [] — "unchanged ingest behaviour". That was
    // the ratchet: the file is dropped, so it never becomes known, so it is
    // dropped again on every later scan. On prod it emptied Juanes' Un Día
    // Normal to 0 rows against 10 files on disk.
    const file = t('02 - Es Por Ti.opus', 'Es Por Ti', 'opus', 200);
    expect(selectAlbumTracks([file], JUANES_CANONICAL).map((k) => k.relPath)).toEqual([
      file.relPath,
    ]);
  });

  it('keeps a retagged file the library already holds, so the edit reaches persist', () => {
    const track = t('02 - Es Por Ti (Remastered 2022).opus', 'Es Por Ti', 'opus', 200);
    const kept = selectAlbumTracks([track], JUANES_CANONICAL, new Set([track.relPath]));
    expect(kept.map((k) => k.title)).toEqual(['Es Por Ti']);
  });

  it('keeps a foreign rip alongside the known track instead of deleting it (#968)', () => {
    // The tracklist can no longer delete the only copy of anything, so a rip
    // the library does not hold is retained. Curation removes it; a scan must
    // not, because the scan cannot tell it apart from a real bonus track —
    // measured on prod, 133 of 134 such drops carried the album's own artist.
    const known = t('01 - A Dios Le Pido.opus', 'A Dios Le Pido', 'opus', 200);
    const foreign = t('99 - Some Other Band - Filler.mp3', 'Some Other Band Filler', 'mp3', 320);
    const kept = selectAlbumTracks([known, foreign], JUANES_CANONICAL, new Set([known.relPath]));
    expect(kept.map((k) => k.relPath).sort()).toEqual([known.relPath, foreign.relPath].sort());
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

// Issue #968: a pinned canonical tracklist routinely describes a DIFFERENT
// edition than the files that landed — Lidarr's Taylor Swift "1989" is the
// Chinese release ("Style 型"), Juanes' is the 2022 remaster, Rosalía's differs
// from the file only in punctuation ("Cap.5:" vs "Cap. 5 -"). Every one of
// those files matched no canonical title and was dropped as foreign, and
// because `knownRelPaths` is read from library_songs the drop is a ratchet: a
// dropped file is never "known" again, so every later scan re-drops it.
// Measured on prod 2026-09-07: 121 tracks unreachable, and of the files being
// dropped 133 carried the album's own artist against 1 that did not.
// The tracklist ranks duplicate files of a track; it never deletes the only copy.
describe('selectAlbumTracks — a canonical list never deletes the only copy (#968)', () => {
  const REMASTER_CANONICAL = [
    'A Dios Le Pido (Remastered 2022)',
    'Es Por Tí (Remastered 2022)',
    'Un Día Normal (Remastered 2022)',
  ];

  it('keeps a track the canonical list does not name when nothing else covers it', () => {
    const only = t('03 - Un Día Normal.opus', 'Un Día Normal', 'opus', 200);
    expect(selectAlbumTracks([only], REMASTER_CANONICAL).map((k) => k.relPath)).toEqual([
      only.relPath,
    ]);
  });

  it('does not empty an album whose canonical list is a different edition', () => {
    // The real prod shape: 10 of 10 files matched nothing, 0 library rows.
    const files = [
      t('03 - Un Día Normal.opus', 'Un Día Normal', 'opus', 200),
      t('06 - Luna.opus', 'Luna', 'opus', 200),
      t('08 - Mala Gente.opus', 'Mala Gente', 'opus', 200),
    ];
    expect(selectAlbumTracks(files, REMASTER_CANONICAL)).toHaveLength(3);
  });

  it('keeps a near-miss that differs from the canonical title only in punctuation', () => {
    const rosalia = t('05 - Reniego.opus', 'Reniego (Cap. 5 - Lamento)', 'opus', 200);
    const kept = selectAlbumTracks(
      [rosalia],
      ['RENIEGO (Cap.5: Lamento)', 'MALAMENTE (Cap.1: Augurio)'],
    );
    expect(kept.map((k) => k.relPath)).toEqual([rosalia.relPath]);
  });

  it('still collapses duplicate copies of one unnamed track to the best file', () => {
    // Retention must not become a duplicate factory: the floor keeps the track,
    // not every file of it.
    const opus = t('12 - Bonus.opus', 'Playground (Studio Outtake)', 'opus', 200);
    const flac = t('12 - Bonus.flac', 'Playground (Studio Outtake)', 'flac', 900);
    const kept = selectAlbumTracks([opus, flac], REMASTER_CANONICAL);
    expect(kept.map((k) => k.suffix)).toEqual(['flac']);
  });

  it('collapses a canonical-matched file and an unmatched copy of the same track', () => {
    // One keyspace: a file keyed by its canonical match and a file keyed by its
    // own identical title are the same track, so they must not both survive.
    const matched = t(
      '01 - A Dios Le Pido (Remastered 2022).mp3',
      'A Dios Le Pido (Remastered 2022)',
      'mp3',
      320,
    );
    const plain = t(
      '01 - A Dios Le Pido (Remastered 2022).opus',
      'A Dios Le Pido (Remastered 2022)',
      'opus',
      200,
    );
    expect(selectAlbumTracks([matched, plain], REMASTER_CANONICAL)).toHaveLength(1);
  });
});
