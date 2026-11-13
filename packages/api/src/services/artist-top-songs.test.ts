import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  artistTopSongCandidates,
  artistTopSongIds,
  rankTopSongs,
  type TopSongCandidate,
} from './artist-top-songs.js';

let db: Database;
let seq = 0;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  seq = 0;
  db.run(`INSERT INTO users (id, username, password_hash, role) VALUES ('u1', 'ana', 'h', 'user')`);
  db.run(`INSERT INTO users (id, username, password_hash, role) VALUES ('u2', 'bo', 'h', 'user')`);
  db.run(
    `INSERT INTO library_artists (id, name, album_count, synced_at) VALUES ('art', 'Artist', 1, 0)`,
  );
  seedAlbum('alb');
});

function seedAlbum(id: string, hidden = 0): void {
  db.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at, hidden)
     VALUES (?, ?, 'Artist', 'art', 1, 0, 1, ?)`,
    [id, id, hidden],
  );
}

function seedSong(
  id: string,
  o: {
    popularity?: number | null;
    title?: string;
    duration?: number;
    artistId?: string;
    albumId?: string;
    hidden?: number;
  } = {},
): void {
  db.run(
    `INSERT INTO library_songs
       (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix,
        content_type, created, landed_at, synced_at, hidden, popularity)
     VALUES (?, ?, ?, 'Artist', ?, ?, ?, 1000, 320, 'opus', 'audio/ogg', '2024-01-01', 1, 0, ?, ?)`,
    [
      id,
      o.albumId ?? 'alb',
      o.title ?? id,
      o.artistId ?? 'art',
      o.duration ?? 180 + ++seq,
      `/music/${id}.opus`,
      o.hidden ?? 0,
      o.popularity ?? null,
    ],
  );
}

function play(songId: string, times: number, o: { counted?: number; user?: string } = {}): void {
  for (let i = 0; i < times; i++) {
    db.run(
      `INSERT INTO play_events (client_event_id, user_id, song_id, at, ms_played, counted, reason)
       VALUES (?, ?, ?, ?, 200000, ?, 'ended')`,
      [`evt-${++seq}`, o.user ?? 'u1', songId, seq, o.counted ?? 1],
    );
  }
}

const byId = (rows: TopSongCandidate[]) => Object.fromEntries(rows.map((r) => [r.id, r]));

describe('artistTopSongCandidates', () => {
  it('keeps only songs some signal ranks, and tells "never scored" from "scored zero"', () => {
    seedSong('scored', { popularity: 0.8 });
    seedSong('zero', { popularity: 0 });
    seedSong('played');
    seedSong('silent');
    play('played', 3);

    const got = byId(artistTopSongCandidates(db, 'art'));
    expect(Object.keys(got).sort()).toEqual(['played', 'scored', 'zero']);
    expect(got.scored).toMatchObject({ popularity: 0.8, plays: 0 });
    expect(got.zero).toMatchObject({ popularity: 0, plays: 0 });
    expect(got.played).toMatchObject({ popularity: null, plays: 3 });
  });

  it('counts counted plays only, across every listener', () => {
    seedSong('a');
    seedSong('skipped');
    play('a', 2, { user: 'u1' });
    play('a', 1, { user: 'u2' });
    play('a', 4, { counted: 0 });
    play('skipped', 5, { counted: 0 });

    const got = byId(artistTopSongCandidates(db, 'art'));
    expect(got.a.plays).toBe(3);
    expect(got.skipped).toBeUndefined();
  });

  it('includes a song the artist is only credited on, and leaves other artists out', () => {
    seedSong('feat', { artistId: 'other', popularity: 0.5 });
    seedSong('stranger', { artistId: 'other', popularity: 0.9 });
    db.run(
      `INSERT INTO library_song_artists (song_id, artist_id, role, position) VALUES ('feat', 'art', 'featured', 1)`,
    );
    expect(artistTopSongCandidates(db, 'art').map((c) => c.id)).toEqual(['feat']);
  });

  it('leaves out a hidden song and a song on a hidden album', () => {
    seedAlbum('hidden-alb', 1);
    seedSong('hidden-song', { popularity: 0.9, hidden: 1 });
    seedSong('on-hidden-album', { popularity: 0.9, albumId: 'hidden-alb' });
    seedSong('visible', { popularity: 0.1 });
    expect(artistTopSongCandidates(db, 'art').map((c) => c.id)).toEqual(['visible']);
  });

  it('gives two copies of one recording the same key, and an unidentifiable row its own', () => {
    seedSong('album-copy', { title: 'Shape of You', duration: 233, popularity: 0.9 });
    seedSong('single-copy', { title: 'Shape Of You', duration: 233, popularity: 0.9 });
    seedSong('other', { title: 'Perfect', duration: 263, popularity: 0.7 });
    seedSong('no-duration', { title: 'Shape of You', duration: 0, popularity: 0.2 });
    const got = byId(artistTopSongCandidates(db, 'art'));
    expect(got['album-copy'].recordingKey).toBe(got['single-copy'].recordingKey);
    expect(got.other.recordingKey).not.toBe(got['album-copy'].recordingKey);
    expect(got['no-duration'].recordingKey).toBe('song:no-duration');
  });
});

const c = (id: string, popularity: number | null, plays = 0, key = id): TopSongCandidate => ({
  id,
  recordingKey: key,
  popularity,
  plays,
});

describe('rankTopSongs — what holds whichever signal leads', () => {
  it('returns nothing for no candidates', () => {
    expect(rankTopSongs([], 5)).toEqual([]);
  });

  it('never returns more than the limit, and returns fewer when that is all there is', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, i) => c(id, 0.9 - i * 0.1));
    expect(rankTopSongs(many, 5)).toHaveLength(5);
    expect(rankTopSongs(many.slice(0, 2), 5)).toHaveLength(2);
  });

  it('keeps one song per recording', () => {
    const got = rankTopSongs(
      [c('album', 0.9, 0, 'rec'), c('single', 0.9, 4, 'rec'), c('other', 0.5)],
      5,
    );
    expect(got).toHaveLength(2);
    expect(got).toContain('other');
  });

  it('orders the more popular before the less, and the more played before the less', () => {
    expect(rankTopSongs([c('low', 0.2), c('high', 0.9), c('mid', 0.5)], 5)).toEqual([
      'high',
      'mid',
      'low',
    ]);
    expect(rankTopSongs([c('once', null, 1), c('often', null, 9)], 5)).toEqual(['often', 'once']);
  });

  it('does not depend on the order the candidates arrive in', () => {
    const rows = [c('b', 0.5), c('a', 0.5), c('d', null, 2), c('c', null, 2)];
    expect(rankTopSongs(rows, 5)).toEqual(rankTopSongs([...rows].reverse(), 5));
  });

  it('does not mutate its input', () => {
    const rows = [c('low', 0.2), c('high', 0.9)];
    rankTopSongs(rows, 5);
    expect(rows.map((r) => r.id)).toEqual(['low', 'high']);
  });
});

describe('rankTopSongs — provider first', () => {
  it('puts every scored song ahead of a merely played one, then fills with plays', () => {
    expect(rankTopSongs([c('played', null, 99), c('faint', 0.01), c('hit', 0.9)], 5)).toEqual([
      'hit',
      'faint',
      'played',
    ]);
  });

  it('treats a score of 0 as unranked: out with no plays, among the played with some', () => {
    expect(rankTopSongs([c('zero', 0)], 5)).toEqual([]);
    expect(rankTopSongs([c('zero', 0, 2), c('played', null, 5), c('hit', 0.3)], 5)).toEqual([
      'hit',
      'played',
      'zero',
    ]);
  });

  it('breaks a tie on one signal with the other, then with the id', () => {
    expect(rankTopSongs([c('b', 0.5), c('a', 0.5), c('c', 0.5, 3)], 5)).toEqual(['c', 'a', 'b']);
    expect(rankTopSongs([c('y', null, 2), c('x', null, 2)], 5)).toEqual(['x', 'y']);
  });

  it('keeps the best-ranked copy of a recording, without summing plays across copies', () => {
    const rows = [
      c('album', null, 3, 'rec'),
      c('single', null, 3, 'rec'),
      c('rival', null, 5),
      c('scored-copy', 0.4, 0, 'rec2'),
      c('played-copy', null, 50, 'rec2'),
    ];
    expect(rankTopSongs(rows, 5)).toEqual(['scored-copy', 'rival', 'album']);
  });
});

describe('artistTopSongIds', () => {
  it('is empty for an artist nothing ranks — the page then shows no block', () => {
    seedSong('silent-1');
    seedSong('silent-2');
    expect(artistTopSongIds(db, 'art', 5)).toEqual([]);
  });

  it('ranks from the database', () => {
    seedSong('hit', { popularity: 0.9 });
    seedSong('deep-cut', { popularity: 0.1 });
    expect(artistTopSongIds(db, 'art', 5)).toEqual(['hit', 'deep-cut']);
  });
});
