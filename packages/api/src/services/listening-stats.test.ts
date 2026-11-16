import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { recordPlayEvents, type PlayEventInput } from './play-history.js';
import {
  GENRE_SHARE_LIMIT,
  STATS_PERIODS,
  listeningStats,
  resolvePeriod,
} from './listening-stats.js';

let db: Database;

/** 2026-08-10T12:00:00Z — a fixed "now" so period maths is assertable. */
const NOW = Date.UTC(2026, 7, 10, 12, 0, 0);
const DAY = 24 * 3_600_000;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  db.run(`INSERT INTO users (id, username, password_hash, role) VALUES ('u1', 'ana', 'h', 'user')`);
  db.run(`INSERT INTO users (id, username, password_hash, role) VALUES ('u2', 'bo', 'h', 'user')`);
});

function seedAlbum(id: string, name: string, artist: string): void {
  db.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at, hidden)
     VALUES (?, ?, ?, ?, 1, 0, 1, 0)`,
    [id, name, artist, `art-${artist}`],
  );
}

function seedSong(
  id: string,
  opts: { album?: string; artist?: string; title?: string; genre?: string } = {},
): void {
  const album = opts.album ?? 'al';
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size,
                                created, synced_at, hidden, landed_at, genre)
     VALUES (?, ?, ?, ?, ?, 180, ?, 100, '2024-01-01', 1, 0, 1, ?)`,
    [
      id,
      album,
      opts.title ?? id,
      opts.artist ?? 'Artist',
      `art-${opts.artist ?? 'Artist'}`,
      `/m/${id}.opus`,
      opts.genre ?? null,
    ],
  );
  if (opts.genre) {
    db.run(`INSERT INTO library_song_genres (song_id, genre, position) VALUES (?, ?, 0)`, [
      id,
      opts.genre,
    ]);
  }
}

let seq = 0;
/** A counted play (200s of a 300s track clears the half-track threshold). */
function play(songId: string, at: number, over: Partial<PlayEventInput> = {}): PlayEventInput {
  seq += 1;
  return {
    clientEventId: `evt-${seq}`,
    songId,
    startedAt: at,
    msPlayed: 200_000,
    durationMs: 300_000,
    reason: 'ended',
    source: 'album',
    device: 'browser',
    title: songId,
    artist: 'Artist',
    album: 'Album',
    ...over,
  };
}

describe('resolvePeriod', () => {
  it('30d looks back thirty days from now', () => {
    const { from, to } = resolvePeriod('30d', NOW);
    expect(to).toBe(NOW);
    expect(from).toBe(NOW - 30 * DAY);
  });

  it('year starts at January 1st of the current year, not 365 days ago', () => {
    const { from } = resolvePeriod('year', NOW);
    expect(new Date(from).getUTCFullYear()).toBe(2026);
    expect(new Date(from).getUTCMonth()).toBe(0);
    expect(new Date(from).getUTCDate()).toBe(1);
  });

  it('all reaches back to the epoch', () => {
    expect(resolvePeriod('all', NOW).from).toBe(0);
  });

  it('falls back to 30d for an unknown period rather than throwing', () => {
    expect(resolvePeriod('nonsense' as never, NOW)).toEqual(resolvePeriod('30d', NOW));
  });

  it('exposes exactly the periods the UI offers', () => {
    expect(STATS_PERIODS).toEqual(['30d', 'year', 'all']);
  });
});

describe('listeningStats', () => {
  beforeEach(() => {
    seedAlbum('al', 'Album', 'Artist');
    seedAlbum('al2', 'Second Album', 'Other Artist');
  });

  it('totals plays, distinct tracks and listening time', () => {
    seedSong('a');
    seedSong('b');
    recordPlayEvents(db, 'u1', [
      play('a', NOW - DAY),
      play('a', NOW - 2 * DAY),
      play('b', NOW - 3 * DAY),
    ]);

    const stats = listeningStats(db, 'u1', '30d', NOW);
    expect(stats.totals).toMatchObject({
      plays: 3,
      distinctSongs: 2,
      // 3 × 200s listened.
      msPlayed: 600_000,
    });
  });

  it('ranks top songs by play count', () => {
    seedSong('a', { title: 'Played Twice' });
    seedSong('b', { title: 'Played Once' });
    recordPlayEvents(db, 'u1', [
      play('a', NOW - DAY),
      play('a', NOW - 2 * DAY),
      play('b', NOW - DAY),
    ]);

    const [first, second] = listeningStats(db, 'u1', '30d', NOW).topSongs;
    expect(first).toMatchObject({ songId: 'a', title: 'Played Twice', plays: 2 });
    expect(second).toMatchObject({ songId: 'b', plays: 1 });
  });

  it('ranks artists and albums by play count across their tracks', () => {
    seedSong('a', { artist: 'Artist', album: 'al' });
    seedSong('b', { artist: 'Artist', album: 'al' });
    seedSong('c', { artist: 'Other Artist', album: 'al2' });
    recordPlayEvents(db, 'u1', [play('a', NOW - DAY), play('b', NOW - DAY), play('c', NOW - DAY)]);

    const stats = listeningStats(db, 'u1', '30d', NOW);
    expect(stats.topArtists[0]).toMatchObject({ artist: 'Artist', plays: 2 });
    expect(stats.topAlbums[0]).toMatchObject({ album: 'Album', plays: 2 });
  });

  it('ranks genres through the multi-genre join, not the primary column alone', () => {
    seedSong('a', { genre: 'Cumbia' });
    seedSong('b', { genre: 'Cumbia' });
    seedSong('c', { genre: 'Rock' });
    // A second genre on 'a' — the join table is the source of truth.
    db.run(`INSERT INTO library_song_genres (song_id, genre, position) VALUES ('a', 'Rock', 1)`);
    recordPlayEvents(db, 'u1', [play('a', NOW - DAY), play('b', NOW - DAY), play('c', NOW - DAY)]);

    const genres = listeningStats(db, 'u1', '30d', NOW).topGenres;
    expect(genres.find((g) => g.genre === 'Cumbia')?.plays).toBe(2);
    expect(genres.find((g) => g.genre === 'Rock')?.plays).toBe(2);
  });

  it('genre share counts each play once, under its primary genre', () => {
    seedSong('a', { genre: 'Cumbia' });
    seedSong('b', { genre: 'Cumbia' });
    seedSong('c', { genre: 'Rock' });
    db.run(`INSERT INTO library_song_genres (song_id, genre, position) VALUES ('a', 'Rock', 1)`);
    recordPlayEvents(db, 'u1', [play('a', NOW - DAY), play('b', NOW - DAY), play('c', NOW - DAY)]);

    const share = listeningStats(db, 'u1', '30d', NOW).genreShare;
    expect(share.totalPlays).toBe(3);
    expect(share.slices).toEqual([
      { genre: 'Cumbia', plays: 2, share: 2 / 3 },
      { genre: 'Rock', plays: 1, share: 1 / 3 },
    ]);
    expect(share.untagged.plays).toBe(0);
  });

  it('genre share parts sum to total plays, junk and deleted songs untagged', () => {
    seedSong('tagged', { genre: 'Cumbia' });
    seedSong('none');
    seedSong('junk', { genre: 'Other' });
    recordPlayEvents(db, 'u1', [
      play('tagged', NOW - DAY),
      play('none', NOW - DAY),
      play('junk', NOW - DAY),
      play('gone', NOW - DAY),
    ]);

    const stats = listeningStats(db, 'u1', '30d', NOW);
    const share = stats.genreShare;
    const sliceSum = share.slices.reduce((n, s) => n + s.plays, 0);
    expect(sliceSum + share.other.plays + share.untagged.plays).toBe(stats.totals.plays);
    expect(share.untagged).toEqual({ plays: 3, share: 3 / 4 });
    expect(share.slices.map((s) => s.genre)).toEqual(['Cumbia']);
  });

  it('folds genres beyond GENRE_SHARE_LIMIT into other', () => {
    const events: PlayEventInput[] = [];
    // g0..g9 with 10..1 plays, except g3 and g4 tied at 7 to pin the name order.
    const counts = [10, 9, 8, 7, 7, 5, 4, 3, 2, 1];
    counts.forEach((n, i) => {
      seedSong(`s${i}`, { genre: `Genre ${String.fromCharCode(74 - i)}` });
      for (let k = 0; k < n; k += 1) events.push(play(`s${i}`, NOW - DAY));
    });
    recordPlayEvents(db, 'u1', events);

    const share = listeningStats(db, 'u1', '30d', NOW).genreShare;
    expect(share.slices).toHaveLength(GENRE_SHARE_LIMIT);
    expect(share.slices.map((s) => s.plays)).toEqual([10, 9, 8, 7, 7, 5, 4, 3]);
    // Tied at 7: 'Genre F' (i=4) sorts before 'Genre G' (i=3).
    expect(share.slices[3]?.genre).toBe('Genre F');
    expect(share.slices[4]?.genre).toBe('Genre G');
    expect(share.other).toEqual({ plays: 3, share: 3 / 56, genreCount: 2 });
    expect(share.untagged.plays).toBe(0);
  });

  it('buckets plays by local hour of day', () => {
    seedSong('a');
    // Two plays in the same hour, one in another. Hours are local-time by
    // design — "when do I listen" is a wall-clock question.
    const morning = new Date(2026, 7, 9, 9, 30).getTime();
    const night = new Date(2026, 7, 9, 23, 15).getTime();
    recordPlayEvents(db, 'u1', [play('a', morning), play('a', morning + 60_000), play('a', night)]);

    const clock = listeningStats(db, 'u1', '30d', NOW).clock;
    expect(clock).toHaveLength(24);
    expect(clock[9]).toBe(2);
    expect(clock[23]).toBe(1);
    expect(clock[3]).toBe(0);
  });

  it('excludes plays outside the period', () => {
    seedSong('a');
    recordPlayEvents(db, 'u1', [play('a', NOW - 60 * DAY)]);

    expect(listeningStats(db, 'u1', '30d', NOW).totals.plays).toBe(0);
    expect(listeningStats(db, 'u1', 'all', NOW).totals.plays).toBe(1);
  });

  it('counts only plays that actually counted', () => {
    seedSong('a');
    recordPlayEvents(db, 'u1', [
      play('a', NOW - DAY, { msPlayed: 4_000, reason: 'skipped' }),
      play('a', NOW - DAY),
    ]);
    expect(listeningStats(db, 'u1', '30d', NOW).totals.plays).toBe(1);
  });

  it('never mixes in another user’s listening', () => {
    seedSong('a');
    seedSong('b');
    recordPlayEvents(db, 'u1', [play('a', NOW - DAY)]);
    recordPlayEvents(db, 'u2', [play('b', NOW - DAY), play('b', NOW - 2 * DAY)]);

    const stats = listeningStats(db, 'u1', '30d', NOW);
    expect(stats.totals.plays).toBe(1);
    expect(stats.topSongs.map((s) => s.songId)).toEqual(['a']);
  });

  it('returns an empty-but-shaped result for a user with no history', () => {
    const stats = listeningStats(db, 'u1', 'all', NOW);
    expect(stats.totals).toEqual({ plays: 0, distinctSongs: 0, distinctArtists: 0, msPlayed: 0 });
    expect(stats.topSongs).toEqual([]);
    expect(stats.topArtists).toEqual([]);
    expect(stats.topGenres).toEqual([]);
    expect(stats.genreShare).toEqual({
      totalPlays: 0,
      slices: [],
      other: { plays: 0, share: 0, genreCount: 0 },
      untagged: { plays: 0, share: 0 },
    });
    // The clock is always 24 buckets so the chart never has to special-case it.
    expect(stats.clock).toHaveLength(24);
    expect(stats.clock.every((n) => n === 0)).toBe(true);
  });

  it('survives a play whose song was deleted, using the event snapshot', () => {
    // No seedSong — the library row is gone, but the event remembers the track.
    recordPlayEvents(db, 'u1', [
      play('gone', NOW - DAY, { title: 'Deleted Track', artist: 'Ghost' }),
    ]);

    const stats = listeningStats(db, 'u1', '30d', NOW);
    expect(stats.totals.plays).toBe(1);
    expect(stats.topSongs[0]).toMatchObject({ title: 'Deleted Track', artist: 'Ghost' });
  });

  it('caps each ranked list', () => {
    for (let i = 0; i < 30; i += 1) seedSong(`s${i}`, { artist: `Artist ${i}` });
    recordPlayEvents(
      db,
      'u1',
      Array.from({ length: 30 }, (_, i) => play(`s${i}`, NOW - DAY)),
    );

    const stats = listeningStats(db, 'u1', '30d', NOW);
    expect(stats.topSongs.length).toBeLessThanOrEqual(10);
    expect(stats.topArtists.length).toBeLessThanOrEqual(10);
  });
});

// #1669: the top lists carry identities and artwork, so a row can be a link.
describe('listeningStats identities and artwork (#1669)', () => {
  function seedArtist(id: string, name: string, coverArt: string | null = null): void {
    db.run(
      `INSERT INTO library_artists (id, name, album_count, cover_art, cover_rev, hidden, split_compound, synced_at)
       VALUES (?, ?, 1, ?, 3, 0, 0, 1)`,
      [id, name, coverArt],
    );
  }
  const credit = (songId: string, artistId: string, role = 'primary') =>
    db.run(
      `INSERT INTO library_song_artists (song_id, artist_id, role, position) VALUES (?, ?, ?, 0)`,
      [songId, artistId, role],
    );
  const plays = (...ids: string[]) =>
    recordPlayEvents(
      db,
      'u1',
      ids.map((id, i) => play(id, NOW - DAY - i * 1000)),
    );
  const stats = (limit?: number) => listeningStats(db, 'u1', '30d', NOW, limit);

  it('a live song, album and artist come back with their ids and cover', () => {
    seedArtist('art-Artist', 'Artist', 'portrait-1');
    seedAlbum('al', 'Album', 'Artist');
    db.run(`UPDATE library_albums SET cover_art = 'cover-al', cover_rev = 7 WHERE id = 'al'`);
    seedSong('a', { artist: 'Artist', album: 'al' });
    plays('a');

    const s = stats();
    expect(s.topSongs[0]).toMatchObject({
      songId: 'a',
      live: true,
      albumId: 'al',
      artistId: 'art-Artist',
      coverArt: 'cover-al',
      coverRev: 7,
    });
    expect(s.topAlbums[0]).toMatchObject({
      albumId: 'al',
      artistId: 'art-Artist',
      coverArt: 'cover-al',
      coverRev: 7,
    });
    expect(s.topArtists[0]).toMatchObject({
      artist: 'Artist',
      artistId: 'art-Artist',
      coverArt: 'portrait-1',
      coverRev: 3,
      coverKind: 'artist',
    });
  });

  it('a deleted song still counts, with no target to link to', () => {
    seedSong('gone', { artist: 'Gone Artist', album: 'al' });
    recordPlayEvents(db, 'u1', [play('gone', NOW - DAY, { artist: 'Gone Artist' })]);
    db.run(`DELETE FROM library_songs WHERE id = 'gone'`);

    const s = stats();
    expect(s.topSongs[0]).toMatchObject({ songId: 'gone', live: false, albumId: null });
    expect(s.topArtists[0]).toMatchObject({
      artist: 'Gone Artist',
      plays: 1,
      artistId: null,
      coverArt: null,
      coverKind: null,
    });
    expect(s.topAlbums[0]).toMatchObject({ albumId: null, coverArt: null });
  });

  it('counts a play toward every credited artist, once each', () => {
    seedArtist('art-main', 'Main');
    seedArtist('art-feat', 'Featured');
    seedSong('duet', { artist: 'Main feat. Featured', album: 'al' });
    credit('duet', 'art-main');
    credit('duet', 'art-feat', 'featuring');
    // The same artist under a second role must not count twice.
    credit('duet', 'art-main', 'producer');
    seedSong('solo', { artist: 'Main', album: 'al' });
    credit('solo', 'art-main');
    plays('duet', 'duet', 'solo');

    const byName = Object.fromEntries(stats().topArtists.map((a) => [a.artist, a.plays]));
    expect(byName).toEqual({ Main: 3, Featured: 2 });
  });

  it('merges name variants of one artist by id, and keeps two artists with one name apart', () => {
    seedArtist('art-x', 'Los Rodríguez');
    seedSong('v1', { artist: 'Los Rodriguez', album: 'al' });
    seedSong('v2', { artist: 'los rodrigues', album: 'al' });
    credit('v1', 'art-x');
    credit('v2', 'art-x');
    seedArtist('art-n1', 'Nirvana');
    seedArtist('art-n2', 'Nirvana');
    seedSong('n1', { artist: 'Nirvana', album: 'al' });
    seedSong('n2', { artist: 'Nirvana', album: 'al' });
    credit('n1', 'art-n1');
    credit('n2', 'art-n2');
    plays('v1', 'v2', 'n1', 'n2');

    const top = stats().topArtists;
    expect(top.find((a) => a.artistId === 'art-x')).toMatchObject({
      artist: 'Los Rodríguez',
      plays: 2,
    });
    expect(
      top
        .filter((a) => a.artist === 'Nirvana')
        .map((a) => a.artistId)
        .sort(),
    ).toEqual(['art-n1', 'art-n2']);
  });

  it("an artist with no portrait borrows its largest album's cover, and says so", () => {
    seedArtist('art-Artist', 'Artist', null);
    seedAlbum('al', 'Album', 'Artist');
    db.run(`UPDATE library_albums SET cover_art = 'cover-al', cover_rev = 2 WHERE id = 'al'`);
    seedSong('a', { artist: 'Artist', album: 'al' });
    plays('a');
    expect(stats().topArtists[0]).toMatchObject({
      coverArt: 'cover-al',
      coverRev: 2,
      coverKind: 'album',
    });
  });

  it('keeps the default of 10 rows and honours a larger limit', () => {
    for (let i = 0; i < 14; i++) {
      seedSong(`s${i}`, { artist: `Artist ${i}`, album: 'al', title: `Song ${i}` });
    }
    plays(...Array.from({ length: 14 }, (_, i) => `s${i}`));
    expect(stats().topSongs).toHaveLength(10);
    expect(stats().topArtists).toHaveLength(10);
    expect(stats(25).topSongs).toHaveLength(14);
    expect(stats(25).topArtists).toHaveLength(14);
  });
});
