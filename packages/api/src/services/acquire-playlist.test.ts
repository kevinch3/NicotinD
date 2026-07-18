import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { resolveAcquireJobTracks } from './acquire-playlist.js';
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