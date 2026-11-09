import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  clusterDuplicateSongs,
  duplicateSongFacts,
  markSameRelease,
  normalizeDupKey,
  releaseKey,
} from './duplicate-songs.js';

describe('clusterDuplicateSongs (#951)', () => {
  it('groups folded artist+title within 2 s, best copy first, and never a row that folds to nothing', () => {
    const c = clusterDuplicateSongs([
      {
        title: 'Más cerca del cielo',
        artist: 'Los Pericos',
        duration: 200,
        suffix: 'mp3',
        bitRate: 128,
      },
      {
        title: 'Mas cerca del cielo',
        artist: 'los pericos',
        duration: 201,
        suffix: 'flac',
        bitRate: 900,
      },
      { title: 'Mas cerca del cielo', artist: 'Los Pericos', duration: 260 },
      { title: '!!!', artist: '???', duration: 10 },
      { title: '...', artist: '---', duration: 10 },
    ]);
    expect(c).toHaveLength(1);
    expect(c[0]!.map((s) => s.suffix)).toEqual(['flac', 'mp3']);
    expect(normalizeDupKey('!!!', '???')).toBeNull();
  });
});

describe('duplicateSongFacts (#951)', () => {
  it('counts clusters and redundant files over visible songs, largest first', () => {
    const db = new Database(':memory:');
    applySchema(db);
    db.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, cover_art, song_count, duration, synced_at)
       VALUES ('a1', 'Pampas Reggae', 'Los Pericos', 'ar', 'a1', 3, 600, 0),
              ('a2', 'Pampas reggae', 'Pericos', 'ar', 'a2', 1, 200, 0)`,
    );
    const song = (id: string, album: string, title: string, dur: number, hidden = 0) =>
      db.run(
        `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, hidden, synced_at)
         VALUES (?, ?, ?, 'Los Pericos', 'ar', ?, ?, ?, 0)`,
        [id, album, title, dur, `${id}.mp3`, hidden],
      );
    song('s1', 'a1', 'Parate y mira', 200);
    song('s2', 'a2', 'Parate y Mira', 201);
    song('s3', 'a1', 'Parate y mira', 199);
    song('s4', 'a1', 'Runaway', 180);
    song('s5', 'a1', 'Runaway', 180, 1); // hidden: not a visible duplicate

    const f = duplicateSongFacts(db, 10);
    expect(f.metric).toEqual({ clusters: 1, redundantFiles: 2, sameReleaseFiles: 2 });
    expect(f.worklist[0]).toMatchObject({ copies: 3 });
    expect(f.worklist[0]!.albums.sort()).toEqual(['Pampas Reggae', 'Pampas reggae']);
  });
});

// The finder pre-arms what `sameRelease` marks, so a cross-release copy marked
// true is a compilation track deleted (#1791).
describe('releaseKey / markSameRelease (#1791)', () => {
  it.each([
    ['2015 - 7', '7 (2015)'],
    ['Corazón de Papel', 'corazon de papel'],
    ['2001 - Coolio.com', 'Coolio.com (2001)'],
    ['1978 - Van Halen (2000 HDCD RM)', 'Van Halen'],
  ])('%s and %s are one release', (a, b) => {
    expect(releaseKey(a)).toBe(releaseKey(b));
  });

  it.each([
    ['Are You Gonna Go My Way', 'Greatest Hits'],
    ['7 (2015)', '7 Tour - Nantes 21 mars 2019'],
    ['Mi sangre', 'Tr3s Presents MTV Unplugged'],
  ])('%s and %s are different releases', (a, b) => {
    expect(releaseKey(a)).not.toBe(releaseKey(b));
  });

  it('marks only the best copy and its own release', () => {
    const marked = markSameRelease([
      { id: 'best', album: '7 (2015)' },
      { id: 'twin', album: '2015 - 7' },
      { id: 'live', album: '7 Tour - Nantes 21 mars 2019' },
    ]);
    expect(marked.map((s) => [s.id, s.sameRelease])).toEqual([
      ['best', true],
      ['twin', true],
      ['live', false],
    ]);
  });

  it('never marks a copy with no album as the same release', () => {
    const marked = markSameRelease([
      { id: 'a', album: '' },
      { id: 'b', album: '' },
    ]);
    expect(marked[1]!.sameRelease).toBe(false);
  });
});
