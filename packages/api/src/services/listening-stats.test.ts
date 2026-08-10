import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { recordPlayEvents, type PlayEventInput } from './play-history.js';
import { STATS_PERIODS, listeningStats, resolvePeriod } from './listening-stats.js';

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
