import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { songId } from './library-scanner.js';
import { upsertGenreOverride } from './genre-overrides.js';
import {
  carryReplacedSongs,
  replacedLibraryFiles,
  snapshotReplacedSongs,
} from './song-replace-carry.js';

const OLD = 'Artist/Album/01 - Song.mp3';
const NEW = 'Artist/Album/01 - Song.flac';
const oldId = songId(OLD);
const newId = songId(NEW);

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  db.run(`INSERT INTO users (id, username, password_hash, role, created_at)
          VALUES ('u', 'u', 'x', 'admin', '2026-01-01')`);
  db.run(`INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
          VALUES ('alb', 'Album', 'Artist', 'art', 1, 180, 1)`);
});

function song(id: string, path: string, albumId = 'alb', extra: { starred?: string } = {}): void {
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, starred, synced_at)
     VALUES (?, ?, 'Song', 'Artist', 'art', 180, ?, ?, 1)`,
    [id, albumId, path, extra.starred ?? null],
  );
}

/** Everything a listener built on the old copy: a like, two playlists, plays, a genre fix, lyrics. */
function curate(id: string): void {
  db.run(`INSERT INTO playlists (id, name, user_id, kind, created_at, modified_at)
          VALUES ('pl', 'Mine', 'u', 'user', 1, 1), ('liked', 'Liked Songs', 'u', 'liked', 1, 1)`);
  db.run(
    `INSERT INTO playlist_songs (playlist_id, song_id, position, added_at)
     VALUES ('pl', ?, 0, 1), ('liked', ?, 0, 1)`,
    [id, id],
  );
  db.run(
    `INSERT INTO play_events (client_event_id, user_id, song_id, title, artist, at, ms_played, reason, counted)
     VALUES ('e1', 'u', ?, 'Song', 'Artist', 1, 180000, 'ended', 1),
            ('e2', 'u', ?, 'Song', 'Artist', 2, 180000, 'ended', 1)`,
    [id, id],
  );
  upsertGenreOverride(db, {
    scope: 'song',
    key: id,
    genres: ['Reggae'],
    source: 'user',
    mbid: null,
    confidence: null,
    status: 'applied',
    note: null,
    mode: 'replace',
  });
  db.run(
    `INSERT INTO library_lyrics (song_id, plain_text, source, updated_at) VALUES (?, 'la la', 'lrclib', 1)`,
    [id],
  );
}

const count = (sql: string, ...args: string[]) =>
  (db.query<{ c: number }, string[]>(sql).get(...args) ?? { c: 0 }).c;

/** What the album reconcile does after the swap: index the new file, prune the vanished one. */
function scan(): void {
  song(newId, NEW);
  db.run('DELETE FROM library_songs WHERE id = ?', [oldId]);
}

describe('replacedLibraryFiles', () => {
  it('keeps only a library file that lost to a file this batch placed', () => {
    const superseded = {
      [OLD]: NEW, // library copy replaced by the incoming one
      'Artist/Album/02 - In.mp3': 'Artist/Album/02 - Held.flac', // incoming lost to the library
      'Artist/Album/03 - A.mp3': 'Artist/Album/03 - B.flac', // two library copies, no incoming
    };
    const incoming = new Set([NEW, 'Artist/Album/02 - In.mp3']);
    expect(replacedLibraryFiles(superseded, incoming)).toEqual([{ fromPath: OLD, toPath: NEW }]);
  });
});

describe('carrying a replaced song (#2032)', () => {
  it('moves likes, playlist membership, plays, the genre fix and lyrics onto the new copy', () => {
    song(oldId, OLD, 'alb', { starred: '2026-01-01T00:00:00Z' });
    curate(oldId);

    const snap = snapshotReplacedSongs(db, [{ fromPath: OLD, toPath: NEW }]);
    scan();
    expect(carryReplacedSongs(db, snap)).toBe(1);

    expect(
      db
        .query<{ starred: string }, [string]>('SELECT starred FROM library_songs WHERE id = ?')
        .get(newId),
    ).toEqual({ starred: '2026-01-01T00:00:00Z' });
    expect(count('SELECT COUNT(*) AS c FROM playlist_songs WHERE song_id = ?', newId)).toBe(2);
    expect(count('SELECT COUNT(*) AS c FROM play_events WHERE song_id = ?', newId)).toBe(2);
    expect(
      count(
        `SELECT COUNT(*) AS c FROM library_genre_overrides WHERE scope = 'song' AND key = ?`,
        newId,
      ),
    ).toBe(1);
    expect(count('SELECT COUNT(*) AS c FROM library_lyrics WHERE song_id = ?', newId)).toBe(1);
    for (const sql of [
      'SELECT COUNT(*) AS c FROM playlist_songs WHERE song_id = ?',
      'SELECT COUNT(*) AS c FROM play_events WHERE song_id = ?',
      'SELECT COUNT(*) AS c FROM library_lyrics WHERE song_id = ?',
      'SELECT COUNT(*) AS c FROM library_songs WHERE id = ?',
    ]) {
      expect(count(sql, oldId)).toBe(0);
    }
  });

  it('still carries the id-keyed history when a scan pruned the row before the snapshot', () => {
    // A full scan overlapping the organize (the library watcher fires seconds
    // after a transcode removes its source) can prune the old row first.
    song(oldId, OLD, 'alb', { starred: '2026-01-01T00:00:00Z' });
    curate(oldId);
    scan();
    const snap = snapshotReplacedSongs(db, [{ fromPath: OLD, toPath: NEW }]);
    expect(snap).toEqual([{ fromId: oldId, toId: newId, fromPath: OLD, toPath: NEW, held: null }]);

    expect(carryReplacedSongs(db, snap)).toBe(1);
    expect(count('SELECT COUNT(*) AS c FROM playlist_songs WHERE song_id = ?', newId)).toBe(2);
    expect(count('SELECT COUNT(*) AS c FROM play_events WHERE song_id = ?', newId)).toBe(2);
    expect(count('SELECT COUNT(*) AS c FROM library_lyrics WHERE song_id = ?', newId)).toBe(1);
    // Only the row's own columns went with it.
    expect(
      db
        .query<{ starred: string | null }, [string]>(
          'SELECT starred FROM library_songs WHERE id = ?',
        )
        .get(newId),
    ).toEqual({ starred: null });
  });

  it('leaves everything where it is when the scan did not index the new file', () => {
    song(oldId, OLD);
    curate(oldId);
    const snap = snapshotReplacedSongs(db, [{ fromPath: OLD, toPath: NEW }]);
    db.run('DELETE FROM library_songs WHERE id = ?', [oldId]);

    expect(carryReplacedSongs(db, snap)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM playlist_songs WHERE song_id = ?', oldId)).toBe(2);
    expect(count('SELECT COUNT(*) AS c FROM play_events WHERE song_id = ?', oldId)).toBe(2);
  });

  it('drops the old row the scan kept because the new copy went to another album row', () => {
    song(oldId, OLD);
    curate(oldId);
    const snap = snapshotReplacedSongs(db, [{ fromPath: OLD, toPath: NEW }]);
    db.run(`INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
            VALUES ('alb2', 'Album (Deluxe)', 'Artist', 'art', 1, 180, 1)`);
    song(newId, NEW, 'alb2');

    expect(carryReplacedSongs(db, snap)).toBe(1);
    expect(count('SELECT COUNT(*) AS c FROM library_songs WHERE id = ?', oldId)).toBe(0);
    // The old album lost its only song, so it goes too instead of rendering an empty card.
    expect(count(`SELECT COUNT(*) AS c FROM library_albums WHERE id = 'alb'`)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM playlist_songs WHERE song_id = ?', newId)).toBe(2);
  });
});
