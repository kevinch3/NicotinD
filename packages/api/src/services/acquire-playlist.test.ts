import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { recordAcquireJobTrack, resolveAcquireJobTracks } from './acquire-playlist.js';
import { recordAcquisition } from './acquisition-store.js';

function freshDb(): Database {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
}

describe('resolveAcquireJobTracks', () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  function insertSong(id: string, title: string, path: string): void {
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, path, duration, landed_at, synced_at)
       VALUES (?, 'alb', ?, 'artist', 'art', ?, 100, 1, 1)`,
      [id, title, path],
    );
  }

  it('returns an empty list when the job has no landed tracks', () => {
    expect(
      resolveAcquireJobTracks(db, 'job-x', 'https://example.com/p', [
        { position: 0, title: 'A', status: 'done', path: 'a.mp3' },
      ]),
    ).toEqual([]);
  });

  it('resolves paths to song ids in playlist order', () => {
    insertSong('s1', 'Song A', 'Artist1/Album1/track01.mp3');
    insertSong('s2', 'Song B', 'Artist1/Album1/track02.mp3');
    insertSong('s3', 'Song C', 'Artist1/Album1/track03.mp3');
    recordAcquisition(db, {
      relativePath: 'Artist1/Album1/track01.mp3',
      method: 'spotdl',
      sourceRef: 'https://open.spotify.com/playlist/x',
      stage: 'done',
      startedAt: 1,
      completedAt: 1,
    });
    recordAcquisition(db, {
      relativePath: 'Artist1/Album1/track02.mp3',
      method: 'spotdl',
      sourceRef: 'https://open.spotify.com/playlist/x',
      stage: 'done',
      startedAt: 2,
      completedAt: 2,
    });
    recordAcquisition(db, {
      relativePath: 'Artist1/Album1/track03.mp3',
      method: 'spotdl',
      sourceRef: 'https://open.spotify.com/playlist/x',
      stage: 'done',
      startedAt: 3,
      completedAt: 3,
    });
    const ids = resolveAcquireJobTracks(db, 'job-x', 'https://open.spotify.com/playlist/x', [
      { position: 0, title: 'Song A', status: 'done', path: 'track01.mp3' },
      { position: 1, title: 'Song B', status: 'done', path: 'track02.mp3' },
      { position: 2, title: 'Song C', status: 'done', path: 'track03.mp3' },
    ]);
    expect(ids).toEqual(['s1', 's2', 's3']);
  });

  it('skips rows whose status is not done or skipped (partial download)', () => {
    insertSong('s1', 'Song A', 'Artist1/Album1/track01.mp3');
    insertSong('s2', 'Song B', 'Artist1/Album1/track02.mp3');
    recordAcquisition(db, {
      relativePath: 'Artist1/Album1/track01.mp3',
      method: 'spotdl',
      sourceRef: 'https://open.spotify.com/playlist/x',
      stage: 'done',
      startedAt: 1,
      completedAt: 1,
    });
    recordAcquisition(db, {
      relativePath: 'Artist1/Album1/track02.mp3',
      method: 'spotdl',
      sourceRef: 'https://open.spotify.com/playlist/x',
      stage: 'done',
      startedAt: 2,
      completedAt: 2,
    });
    // Plugin reported all 3 tracks, but track02's file never landed.
    const ids = resolveAcquireJobTracks(db, 'job-x', 'https://open.spotify.com/playlist/x', [
      { position: 0, title: 'Song A', status: 'done', path: 'track01.mp3' },
      { position: 1, title: 'Song B', status: 'failed', path: 'track02.mp3' },
      { position: 2, title: 'Song C', status: 'downloading', path: 'track03.mp3' },
    ]);
    expect(ids).toEqual(['s1']);
  });

  it('de-dups song ids when two rows point at the same landed file', () => {
    insertSong('s1', 'Song A', 'Artist1/Album1/track01.mp3');
    recordAcquisition(db, {
      relativePath: 'Artist1/Album1/track01.mp3',
      method: 'spotdl',
      sourceRef: 'https://open.spotify.com/playlist/x',
      stage: 'done',
      startedAt: 1,
      completedAt: 1,
    });
    const ids = resolveAcquireJobTracks(db, 'job-x', 'https://open.spotify.com/playlist/x', [
      { position: 0, title: 'Song A', status: 'downloading', path: 'track01.mp3' },
      { position: 1, title: 'Song A', status: 'done', path: 'track01.mp3' },
    ]);
    expect(ids).toEqual(['s1']);
  });

  it('scopes the lookup to the job URL (no cross-acquisition leakage)', () => {
    insertSong('s1', 'Song A', 'Artist1/Album1/track01.mp3');
    // A different job (different URL) that landed the same file — should NOT
    // match this job's playlist, otherwise two Spotify playlists sharing an
    // artist would share tracks.
    recordAcquisition(db, {
      relativePath: 'Artist1/Album1/track01.mp3',
      method: 'spotdl',
      sourceRef: 'https://open.spotify.com/playlist/other',
      stage: 'done',
      startedAt: 1,
      completedAt: 1,
    });
    const ids = resolveAcquireJobTracks(db, 'job-x', 'https://open.spotify.com/playlist/x', [
      { position: 0, title: 'Song A', status: 'done', path: 'track01.mp3' },
    ]);
    // Different source_ref → no match → empty list.
    expect(ids).toEqual([]);
  });

  it('falls back to title matching when basename lookup misses', () => {
    // simulate the spotdl case: path is just the file basename the plugin
    // knows, and the organizer's move put it under a deeper path.
    insertSong('s1', 'Song A', 'Artist1/Album1/track01.mp3');
    recordAcquisition(db, {
      relativePath: 'Artist1/Album1/track01.mp3',
      method: 'spotdl',
      sourceRef: 'https://open.spotify.com/playlist/x',
      stage: 'done',
      startedAt: 1,
      completedAt: 1,
    });
    // Plugin only knows the title (no path), or path doesn't match a real
    // basename in the library.
    const ids = resolveAcquireJobTracks(db, 'job-x', 'https://open.spotify.com/playlist/x', [
      { position: 0, title: 'Song A', status: 'done', path: 'different-basename.mp3' },
    ]);
    expect(ids).toEqual(['s1']);
  });
});
describe('recordAcquireJobTrack', () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
    db.run(
      `INSERT INTO acquire_jobs (id, backend, url, state, stage) VALUES ('job-1', 'ytdlp', 'u', 'running', 'downloading')`,
    );
  });

  function rows(): { position: number; title: string; status: string; path: string }[] {
    return db
      .query<{ position: number; title: string; status: string; path: string }, []>(
        `SELECT position, title, status, path FROM acquire_job_tracks WHERE job_id = 'job-1' ORDER BY position`,
      )
      .all();
  }

  it('appends new titles at increasing positions', () => {
    recordAcquireJobTrack(db, 'job-1', { title: 'A', status: 'downloading', path: 'a.opus' });
    recordAcquireJobTrack(db, 'job-1', { title: 'B', status: 'downloading', path: 'b.opus' });
    expect(rows()).toEqual([
      { position: 0, title: 'A', status: 'downloading', path: 'a.opus' },
      { position: 1, title: 'B', status: 'downloading', path: 'b.opus' },
    ]);
  });

  it('updates the same row in place when a title re-emits (downloading -> done)', () => {
    recordAcquireJobTrack(db, 'job-1', { title: 'A', status: 'downloading', path: 'a.part' });
    recordAcquireJobTrack(db, 'job-1', { title: 'A', status: 'done', path: 'a.opus' });
    // One row, final status + the latest path (post-processing may change it).
    expect(rows()).toEqual([{ position: 0, title: 'A', status: 'done', path: 'a.opus' }]);
  });

  it('stores a title-only event (no path) as a row with an empty path', () => {
    // spotdl only logs titles; the playlist resolver must still get a row so
    // the title fallback has something to walk.
    recordAcquireJobTrack(db, 'job-1', { title: 'Artist - Song', status: 'done' });
    expect(rows()).toEqual([{ position: 0, title: 'Artist - Song', status: 'done', path: '' }]);
  });

  it('keeps an existing path when a later event for the same title omits it', () => {
    recordAcquireJobTrack(db, 'job-1', { title: 'A', status: 'downloading', path: 'a.opus' });
    recordAcquireJobTrack(db, 'job-1', { title: 'A', status: 'done' });
    expect(rows()).toEqual([{ position: 0, title: 'A', status: 'done', path: 'a.opus' }]);
  });

  it('is idempotent across a retry that re-emits the whole track list', () => {
    for (let round = 0; round < 2; round++) {
      recordAcquireJobTrack(db, 'job-1', { title: 'A', status: 'done', path: 'a.opus' });
      recordAcquireJobTrack(db, 'job-1', { title: 'B', status: 'done', path: 'b.opus' });
    }
    expect(rows()).toEqual([
      { position: 0, title: 'A', status: 'done', path: 'a.opus' },
      { position: 1, title: 'B', status: 'done', path: 'b.opus' },
    ]);
  });
});

describe('resolveAcquireJobTracks — stem + title-shape fallbacks', () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  function insertSong(id: string, title: string, path: string): void {
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, path, duration, landed_at, synced_at)
       VALUES (?, 'alb', ?, 'artist', 'art', ?, 100, 1, 1)`,
      [id, title, path],
    );
  }

  function acquired(relativePath: string): void {
    recordAcquisition(db, {
      relativePath,
      method: 'ytdlp',
      sourceRef: 'https://example.com/playlist',
      stage: 'done',
      startedAt: 1,
      completedAt: 1,
    });
  }

  it('matches on the basename stem when the extension changed (lossless -> Opus transcode)', () => {
    insertSong('s1', 'Song A', 'Artist/Album/track01.opus');
    acquired('Artist/Album/track01.opus');
    const ids = resolveAcquireJobTracks(db, 'job-1', 'https://example.com/playlist', [
      { position: 0, title: 'Different Title', status: 'done', path: 'track01.flac' },
    ]);
    expect(ids).toEqual(['s1']);
  });

  it('resolves a title-only row (empty path) via the title fallback', () => {
    insertSong('s1', 'Song A', 'Artist/Album/track01.mp3');
    acquired('Artist/Album/track01.mp3');
    const ids = resolveAcquireJobTracks(db, 'job-1', 'https://example.com/playlist', [
      { position: 0, title: 'Song A', status: 'done', path: '' },
    ]);
    expect(ids).toEqual(['s1']);
  });

  it('matches an "Artist - Title" shaped event title against the bare library title', () => {
    // spotdl logs `Downloaded "Artist - Title"` but library_songs.title is
    // just the title — strip leading " - " segments until something matches.
    insertSong('s1', 'Song A', 'Artist/Album/track01.mp3');
    acquired('Artist/Album/track01.mp3');
    const ids = resolveAcquireJobTracks(db, 'job-1', 'https://example.com/playlist', [
      { position: 0, title: 'Some Artist - Song A', status: 'done', path: '' },
    ]);
    expect(ids).toEqual(['s1']);
  });

  it('prefers the exact title even when a stripped variant would also match', () => {
    insertSong('s1', 'Cool Band - Anthem', 'Artist/Album/track01.mp3');
    insertSong('s2', 'Anthem', 'Artist/Album/track02.mp3');
    acquired('Artist/Album/track01.mp3');
    acquired('Artist/Album/track02.mp3');
    const ids = resolveAcquireJobTracks(db, 'job-1', 'https://example.com/playlist', [
      { position: 0, title: 'Cool Band - Anthem', status: 'done', path: '' },
    ]);
    expect(ids).toEqual(['s1']);
  });
});
