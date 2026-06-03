import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { LibraryCurator } from './library-curator.js';
import { setReleaseType } from './release-meta-store.js';

interface AlbumSeed {
  id: string;
  name: string;
  artist: string;
  songCount: number;
  manualOverride?: boolean;
  hidden?: boolean;
  classification?: 'album' | 'ep' | 'single' | 'compilation' | 'unknown';
}

function seedAlbum(db: Database, a: AlbumSeed): void {
  db.run(
    `INSERT INTO library_albums
      (id, name, artist, artist_id, song_count, duration, created, synced_at,
       classification, hidden, manual_override)
     VALUES (?, ?, ?, ?, ?, 0, '2024-01-01', 0, ?, ?, ?)`,
    [
      a.id,
      a.name,
      a.artist,
      `artist-${a.id}`,
      a.songCount,
      a.classification ?? 'unknown',
      a.hidden ? 1 : 0,
      a.manualOverride ? 1 : 0,
    ],
  );
}

function seedJob(db: Database, artistName: string, albumTitle: string): void {
  db.run(
    `INSERT INTO album_jobs
      (lidarr_album_id, username, directory, canonical_tracks_json, alternates_json,
       state, created_at, artist_name, album_title)
     VALUES (?, ?, ?, ?, ?, 'done', 0, ?, ?)`,
    [1, 'peer', 'dir', '[]', '[]', artistName, albumTitle],
  );
}

function readRow(db: Database, id: string): { hidden: number; classification: string } {
  return db
    .query<{ hidden: number; classification: string }, [string]>(
      'SELECT hidden, classification FROM library_albums WHERE id = ?',
    )
    .get(id)!;
}

describe('LibraryCurator', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
  });

  describe('heuristic release-type bands (no metadata)', () => {
    it('classifies a 1-track album as a visible single', () => {
      seedAlbum(db, { id: 'a1', name: 'Mi Canción', artist: 'Alfredo Casero', songCount: 1 });
      new LibraryCurator(db).reclassifyAll();
      expect(readRow(db, 'a1')).toEqual({ hidden: 0, classification: 'single' });
    });

    it('classifies a 2–6 track album as a visible EP', () => {
      seedAlbum(db, { id: 'a1', name: 'Some EP', artist: 'Babasónicos', songCount: 4 });
      new LibraryCurator(db).reclassifyAll();
      expect(readRow(db, 'a1')).toEqual({ hidden: 0, classification: 'ep' });
    });

    it('classifies a 7+ track album as a visible album', () => {
      seedAlbum(db, { id: 'a1', name: 'Discovery', artist: 'Daft Punk', songCount: 14 });
      new LibraryCurator(db).reclassifyAll();
      expect(readRow(db, 'a1')).toEqual({ hidden: 0, classification: 'album' });
    });

    it('hides the [Unknown Album]/[Unknown Artist] mega-bucket', () => {
      seedAlbum(db, { id: 'a1', name: '[Unknown Album]', artist: '[Unknown Artist]', songCount: 30 });
      new LibraryCurator(db).reclassifyAll();
      expect(readRow(db, 'a1')).toEqual({ hidden: 1, classification: 'unknown' });
    });

    it('hides a 1-track album that also has unknown identity', () => {
      seedAlbum(db, { id: 'a1', name: '[Unknown Album]', artist: 'Real Artist', songCount: 1 });
      new LibraryCurator(db).reclassifyAll();
      expect(readRow(db, 'a1')).toEqual({ hidden: 1, classification: 'unknown' });
    });

    it('classifies compilation-named albums as compilation', () => {
      seedAlbum(db, { id: 'a1', name: 'Greatest Hits', artist: 'Queen', songCount: 18 });
      new LibraryCurator(db).reclassifyAll();
      expect(readRow(db, 'a1')).toEqual({ hidden: 0, classification: 'compilation' });
    });
  });

  describe('metadata-first classification', () => {
    it('lets an authoritative release type override the track-count heuristic', () => {
      // 4 tracks would heuristically be an EP, but Lidarr says it's a single.
      seedAlbum(db, { id: 'a1', name: 'Long Single', artist: 'Some Artist', songCount: 4 });
      setReleaseType(db, 'a1', 'single', { source: 'lidarr' });
      new LibraryCurator(db).reclassifyAll();
      expect(readRow(db, 'a1')).toEqual({ hidden: 0, classification: 'single' });
    });

    it('lets metadata promote a thin release to a full album', () => {
      // 1 track on disk, but the canonical release is a full album.
      seedAlbum(db, { id: 'a1', name: 'Real Album', artist: 'Some Artist', songCount: 1 });
      setReleaseType(db, 'a1', 'album', { source: 'lidarr' });
      new LibraryCurator(db).reclassifyAll();
      expect(readRow(db, 'a1')).toEqual({ hidden: 0, classification: 'album' });
    });

    it('does not let metadata resurrect the unknown/unknown mega-bucket', () => {
      seedAlbum(db, { id: 'a1', name: '[Unknown Album]', artist: '[Unknown Artist]', songCount: 5 });
      setReleaseType(db, 'a1', 'album', { source: 'lidarr' });
      new LibraryCurator(db).reclassifyAll();
      expect(readRow(db, 'a1').hidden).toBe(1);
    });
  });

  describe('overrides & protection', () => {
    it('does not touch an album with manual_override=1', () => {
      seedAlbum(db, {
        id: 'a1',
        name: 'Forced',
        artist: 'Babasónicos',
        songCount: 1,
        manualOverride: true,
        hidden: false,
        classification: 'album',
      });
      new LibraryCurator(db).reclassifyAll();
      expect(readRow(db, 'a1')).toEqual({ hidden: 0, classification: 'album' });
    });

    it('keeps a deliberately-hunted unknown-identity release visible (album_jobs)', () => {
      seedAlbum(db, { id: 'a1', name: '[Unknown Album]', artist: 'Babasónicos', songCount: 1 });
      seedJob(db, 'Babasónicos', '[Unknown Album]');
      new LibraryCurator(db).reclassifyAll();
      expect(readRow(db, 'a1').hidden).toBe(0);
    });
  });
});
