import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  agreedSiblingGenre,
  genreLaneCandidates,
  genreLaneReport,
  titleDeclaredGenres,
} from './genre-lanes.js';

const VOCAB = new Map([
  ['downtempo', 'Downtempo'],
  ['folktronica', 'Folktronica'],
  ['techno', 'Techno'],
  ['acoustic', 'Acoustic'],
]);

describe('titleDeclaredGenres', () => {
  it('reads a bracketed list of known genres, in the library spelling', () => {
    expect(titleDeclaredGenres('Doorways [downtempo / FOLKTRONICA]', VOCAB)).toEqual([
      'Downtempo',
      'Folktronica',
    ]);
  });

  it('ignores a single bracketed word: that is a version, not a genre list', () => {
    expect(titleDeclaredGenres('Song [Acoustic]', VOCAB)).toBeNull();
    expect(titleDeclaredGenres('Song [Techno]', VOCAB)).toBeNull();
  });

  it('needs every part to be a known genre', () => {
    expect(titleDeclaredGenres('Mojave [Downtempo / Slow Rave]', VOCAB)).toBeNull();
  });

  it('ignores round brackets and titles with none', () => {
    expect(titleDeclaredGenres('Song (Downtempo / Techno)', VOCAB)).toBeNull();
    expect(titleDeclaredGenres('Plain title', VOCAB)).toBeNull();
  });

  it('takes the first bracket that qualifies and drops a repeated genre', () => {
    expect(titleDeclaredGenres('A [Live] [Techno, techno; Downtempo]', VOCAB)).toEqual([
      'Techno',
      'Downtempo',
    ]);
  });
});

describe('agreedSiblingGenre', () => {
  const album = (genres: Record<string, number>) => new Map(Object.entries(genres));

  it('needs two albums, each dominated by the same genre', () => {
    const one = new Map([['a1', album({ techno: 9 })]]);
    expect(agreedSiblingGenre(one, null)).toBeNull();
    const two = new Map([
      ['a1', album({ techno: 9 })],
      ['a2', album({ techno: 4, house: 1 })],
    ]);
    expect(agreedSiblingGenre(two, null)).toEqual({ genreKey: 'techno', albums: 2 });
  });

  it('is nothing when two albums disagree', () => {
    const albums = new Map([
      ['a1', album({ techno: 9 })],
      ['a2', album({ techno: 9 })],
      ['a3', album({ house: 5 })],
    ]);
    expect(agreedSiblingGenre(albums, null)).toBeNull();
  });

  it('does not count an album with no dominant genre, nor the song own album', () => {
    const albums = new Map([
      ['a1', album({ techno: 9 })],
      ['mixed', album({ techno: 3, house: 3 })],
      ['own', album({ techno: 5 })],
    ]);
    expect(agreedSiblingGenre(albums, 'own')).toBeNull();
    expect(agreedSiblingGenre(albums, null)).toEqual({ genreKey: 'techno', albums: 2 });
  });
});

describe('genreLaneCandidates', () => {
  let db: Database;
  let n = 0;
  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    n = 0;
  });
  function artist(id: string, name: string): void {
    db.run(
      `INSERT INTO library_artists (id, name, album_count, hidden, split_compound, synced_at)
       VALUES (?, ?, 1, 0, 0, 1)`,
      [id, name],
    );
  }
  function song(artistId: string, albumId: string, title: string, genre: string | null): string {
    const id = `s${++n}`;
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size,
                                  created, synced_at, hidden, landed_at, genre)
       VALUES (?, ?, ?, ?, ?, 180, ?, 1, '2024-01-01', 1, 0, 1, ?)`,
      [id, albumId, title, artistId, artistId, `/m/${id}.opus`, genre],
    );
    return id;
  }
  /** Enough songs carrying each genre for it to be in the auto vocabulary. */
  function vocabulary(...genres: string[]): void {
    for (const g of genres) {
      db.run(
        `INSERT INTO library_genres (name, song_count, album_count, synced_at) VALUES (?, 10, 1, 1)`,
        [g],
      );
    }
  }

  it('finds a title-declared song and a sibling-agreed song, and nothing for a tagged one', () => {
    vocabulary('Techno', 'Downtempo', 'Folktronica');
    artist('ar', 'Artist');
    for (const al of ['a1', 'a2'])
      for (let i = 0; i < 3; i++) song('ar', al, `t${al}${i}`, 'Techno');
    const untagged = song('ar', 'a3', 'New One', null);
    const tagged = song('ar', 'a3', 'Already', 'Techno');
    artist('other', 'Other');
    const declared = song('other', 'b1', 'Doorways [Downtempo / Folktronica]', null);

    const found = genreLaneCandidates(db);
    expect(found.map((c) => [c.songId, c.lane, c.genres])).toEqual([
      [untagged, 'siblings', ['Techno']],
      [declared, 'title', ['Downtempo', 'Folktronica']],
    ]);
    expect(found.map((c) => c.songId)).not.toContain(tagged);
    expect(found[0]!.evidence).toBe('2 other albums by Artist agree');
  });

  it('proposes nothing from one album, however many tracks agree', () => {
    vocabulary('Techno');
    artist('ar', 'Artist');
    for (let i = 0; i < 11; i++) song('ar', 'a1', `t${i}`, 'Techno');
    song('ar', 'a1', 'Straggler', null);
    song('ar', 'a2', 'Elsewhere', null);
    expect(genreLaneCandidates(db)).toEqual([]);
  });

  it('proposes nothing for a genre outside the vocabulary, a catch-all, or Various Artists', () => {
    vocabulary('Techno', 'Electronic');
    artist('rare', 'Rare');
    for (const al of ['a1', 'a2']) song('rare', al, `r${al}`, 'Obscurecore');
    song('rare', 'a3', 'x', null);
    artist('broad', 'Broad');
    for (const al of ['b1', 'b2']) song('broad', al, `b${al}`, 'Electronic');
    song('broad', 'b3', 'y', null);
    artist('va', 'Various Artists');
    for (const al of ['c1', 'c2']) song('va', al, `c${al}`, 'Techno');
    song('va', 'c3', 'z', null);
    expect(genreLaneCandidates(db)).toEqual([]);
  });

  it('treats junk vocab as no genre, both as a candidate and as evidence', () => {
    vocabulary('Techno');
    artist('ar', 'Artist');
    for (const al of ['a1', 'a2']) song('ar', al, `t${al}`, 'Techno');
    song('ar', 'a4', 'junk evidence', 'Music');
    const junk = song('ar', 'a3', 'Junk tagged', 'Music');
    expect(genreLaneCandidates(db).map((c) => c.songId)).toContain(junk);
  });

  it('reports counts per lane, the artists drawn on, and a sample holding both lanes', () => {
    vocabulary('Techno', 'Downtempo', 'Folktronica');
    artist('ar', 'Artist');
    for (const al of ['a1', 'a2']) song('ar', al, `t${al}`, 'Techno');
    for (let i = 0; i < 5; i++) song('ar', 'a3', `New ${i}`, null);
    artist('other', 'Other');
    song('other', 'b1', 'Doorways [Downtempo / Folktronica]', null);

    const report = genreLaneReport(db, 4);
    expect(report.counts).toEqual({ title: 1, siblings: 5 });
    expect(report.siblingArtists).toBe(1);
    expect(report.sample.map((c) => c.lane)).toEqual(['title', 'siblings', 'siblings', 'siblings']);
  });
});
