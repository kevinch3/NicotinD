import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { backfillAcquisitions } from './acquisition-backfill.js';
import { getAcquisitionByPath, recordAcquisition } from './acquisition-store.js';

function seedSong(db: Database, id: string, path: string): void {
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, path, synced_at)
     VALUES (?, 'alb', ?, 'A', 'art', ?, 0)`,
    [id, id, path],
  );
}

function seedDownload(db: Database, key: string, username: string, path: string, at = 1000): void {
  db.run(
    `INSERT INTO completed_downloads (transfer_key, username, directory, filename, relative_path, basename, completed_at)
     VALUES (?, ?, 'd', ?, ?, ?, ?)`,
    [key, username, path, path, path.split('/').pop()!.toLowerCase(), at],
  );
}

describe('backfillAcquisitions', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
  });

  it('resolves a slskd download from completed_downloads', () => {
    seedSong(db, 's1', 'Artist/Album/01.flac');
    seedDownload(db, 'k1', 'peerX', 'Artist/Album/01.flac', 1234);

    const res = backfillAcquisitions(db, { force: true });
    expect(res.matched).toBe(1);
    expect(getAcquisitionByPath(db, 'Artist/Album/01.flac')).toEqual({
      method: 'slskd',
      sourceRef: 'peerX',
      acquiredAt: 1234,
      storagePath: 'Artist/Album/01.flac',
    });
  });

  it('resolves a URL acquisition to its plugin backend', () => {
    seedSong(db, 's2', 'Artist/EP/02.mp3');
    db.run(`INSERT INTO acquire_jobs (id, backend, url, state) VALUES ('job9', 'ytdlp', 'u', 'done')`);
    seedDownload(db, 'k2', 'acquire:job9', 'Artist/EP/02.mp3');

    backfillAcquisitions(db, { force: true });
    expect(getAcquisitionByPath(db, 'Artist/EP/02.mp3')?.method).toBe('ytdlp');
  });

  it('leaves songs with no download link unrecorded and counts them', () => {
    seedSong(db, 's3', 'Imported/Album/03.flac');
    const res = backfillAcquisitions(db, { force: true });
    expect(res.matched).toBe(0);
    expect(res.unresolved).toBe(1);
    expect(getAcquisitionByPath(db, 'Imported/Album/03.flac')).toBeNull();
  });

  it('does not overwrite an existing acquisition row', () => {
    seedSong(db, 's4', 'Artist/Album/04.flac');
    seedDownload(db, 'k4', 'peerX', 'Artist/Album/04.flac');
    recordAcquisition(db, {
      relativePath: 'Artist/Album/04.flac',
      method: 'archive',
      sourceRef: 'https://archive.org/x',
      startedAt: 5,
      completedAt: 9,
    });
    backfillAcquisitions(db, { force: true });
    expect(getAcquisitionByPath(db, 'Artist/Album/04.flac')?.method).toBe('archive');
  });

  it('runs once: the run-once marker short-circuits subsequent calls', () => {
    seedSong(db, 's5', 'Artist/Album/05.flac');
    seedDownload(db, 'k5', 'peerX', 'Artist/Album/05.flac');
    expect(backfillAcquisitions(db).matched).toBe(1);

    // A new song added later is NOT picked up until forced (marker is set).
    seedSong(db, 's6', 'Artist/Album/06.flac');
    seedDownload(db, 'k6', 'peerY', 'Artist/Album/06.flac');
    expect(backfillAcquisitions(db).matched).toBe(0);
    expect(getAcquisitionByPath(db, 'Artist/Album/06.flac')).toBeNull();
  });
});
