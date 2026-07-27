import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { countDanglingPlaylistRows, repointPlaylistsBeforePrune } from './playlist-repoint.js';

let db: Database;
const OLD = 1;
const NEW = 2;

function seedSong(
  id: string,
  opts: { title: string; artist: string; dur: number; synced: number },
) {
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, created, synced_at)
     VALUES (?, 'al', ?, ?, 'art', ?, ?, 100, '2024-01-01', ?)`,
    [id, opts.title, opts.artist, opts.dur, `p/${id}.opus`, opts.synced],
  );
}

function seedPlaylistEntry(songId: string, playlist = 'pl1', position = 0) {
  db.run(
    `INSERT OR IGNORE INTO playlists (id, name, kind, created_at) VALUES (?, 'P', 'user', 1)`,
    [playlist],
  );
  db.run(
    `INSERT INTO playlist_songs (playlist_id, song_id, position, added_at) VALUES (?, ?, ?, 1)`,
    [playlist, songId, position],
  );
}

const memberIds = (playlist = 'pl1') =>
  (
    db
      .query<{ song_id: string }, [string]>(
        `SELECT song_id FROM playlist_songs WHERE playlist_id = ? ORDER BY position`,
      )
      .all(playlist) as Array<{ song_id: string }>
  ).map((r) => r.song_id);

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  db.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
     VALUES ('al','Album','Artist','art',1,0,${NEW})`,
  );
});

/**
 * Song ids are sha1(path), so any move re-mints the id. The scanner then prunes
 * the old row and every playlist_songs row pointing at it dies silently —
 * playlist reads INNER JOIN library_songs, so the entry doesn't error, the
 * playlist just renders one song shorter. Measured on prod: 17 dangling rows
 * across 11 user playlists.
 */
describe('repointPlaylistsBeforePrune', () => {
  it('moves a playlist entry onto the surviving row for the same recording', () => {
    seedSong('old', { title: 'Yo Puedo', artist: 'Decadentes', dur: 210, synced: OLD });
    seedSong('new', { title: 'Yo Puedo', artist: 'Decadentes', dur: 210, synced: NEW });
    seedPlaylistEntry('old');

    expect(repointPlaylistsBeforePrune(db, NEW)).toEqual({ repointed: 1, unmatched: 0 });
    expect(memberIds()).toEqual(['new']);
  });

  /**
   * A wrong re-point silently puts a DIFFERENT song in someone's playlist,
   * which is worse than the dangling entry it replaces.
   */
  it('leaves the entry alone when two survivors match — ambiguity must not guess', () => {
    seedSong('old', { title: 'Intro', artist: 'V', dur: 60, synced: OLD });
    seedSong('a', { title: 'Intro', artist: 'V', dur: 60, synced: NEW });
    seedSong('b', { title: 'Intro', artist: 'V', dur: 60, synced: NEW });
    seedPlaylistEntry('old');

    expect(repointPlaylistsBeforePrune(db, NEW)).toEqual({ repointed: 0, unmatched: 1 });
    expect(memberIds()).toEqual(['old']); // dangles, as it would have before
  });

  it('does not match a different recording of the same title (duration discriminates)', () => {
    // A live cut or remix shares title+artist but not length.
    seedSong('old', { title: 'Song', artist: 'A', dur: 200, synced: OLD });
    seedSong('live', { title: 'Song', artist: 'A', dur: 385, synced: NEW });
    seedPlaylistEntry('old');

    expect(repointPlaylistsBeforePrune(db, NEW)).toEqual({ repointed: 0, unmatched: 1 });
  });

  it('collapses rather than aborting when the playlist already holds the survivor', () => {
    // (playlist_id, song_id) is unique; a plain UPDATE would abort the scan.
    seedSong('old', { title: 'Dup', artist: 'A', dur: 100, synced: OLD });
    seedSong('new', { title: 'Dup', artist: 'A', dur: 100, synced: NEW });
    seedPlaylistEntry('new', 'pl1', 0);
    seedPlaylistEntry('old', 'pl1', 1);

    expect(() => repointPlaylistsBeforePrune(db, NEW)).not.toThrow();
    expect(memberIds()).toEqual(['new', 'old']); // the stale row is left to the prune
  });

  it('ignores doomed songs no playlist references — the overwhelming majority', () => {
    seedSong('old', { title: 'Unloved', artist: 'A', dur: 100, synced: OLD });
    seedSong('new', { title: 'Unloved', artist: 'A', dur: 100, synced: NEW });
    expect(repointPlaylistsBeforePrune(db, NEW)).toEqual({ repointed: 0, unmatched: 0 });
  });

  it('carries an entry across every playlist that holds it', () => {
    seedSong('old', { title: 'Shared', artist: 'A', dur: 120, synced: OLD });
    seedSong('new', { title: 'Shared', artist: 'A', dur: 120, synced: NEW });
    seedPlaylistEntry('old', 'pl1');
    seedPlaylistEntry('old', 'pl2');

    expect(repointPlaylistsBeforePrune(db, NEW).repointed).toBe(2);
    expect(memberIds('pl1')).toEqual(['new']);
    expect(memberIds('pl2')).toEqual(['new']);
  });

  it('reports a genuinely deleted song as unmatched rather than inventing a target', () => {
    seedSong('old', { title: 'Gone', artist: 'A', dur: 100, synced: OLD });
    seedPlaylistEntry('old');
    expect(repointPlaylistsBeforePrune(db, NEW)).toEqual({ repointed: 0, unmatched: 1 });
  });
});

describe('countDanglingPlaylistRows', () => {
  it('counts entries whose song is already gone', () => {
    seedSong('live', { title: 'A', artist: 'A', dur: 1, synced: NEW });
    seedPlaylistEntry('live');
    seedPlaylistEntry('ghost');
    expect(countDanglingPlaylistRows(db)).toBe(1);
  });

  it('is zero on a healthy library', () => {
    seedSong('live', { title: 'A', artist: 'A', dur: 1, synced: NEW });
    seedPlaylistEntry('live');
    expect(countDanglingPlaylistRows(db)).toBe(0);
  });
});
