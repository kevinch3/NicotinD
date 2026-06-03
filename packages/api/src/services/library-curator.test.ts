import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { LibraryCurator } from './library-curator.js';

interface AlbumSeed {
  id: string;
  name: string;
  artist: string;
  songCount: number;
  manualOverride?: boolean;
  hidden?: boolean;
  classification?: 'album' | 'single' | 'compilation' | 'unknown';
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

  it('hides a single-track Singles album', () => {
    seedAlbum(db, { id: 'a1', name: 'Singles', artist: 'Babasónicos', songCount: 1 });
    new LibraryCurator(db).reclassifyAll();
    const row = readRow(db, 'a1');
    expect(row.hidden).toBe(1);
    expect(row.classification).toBe('single');
  });

  it('hides a 3-track Singles album', () => {
    seedAlbum(db, { id: 'a1', name: 'Singles', artist: 'Pescado Rabioso', songCount: 3 });
    new LibraryCurator(db).reclassifyAll();
    const row = readRow(db, 'a1');
    expect(row.hidden).toBe(1);
    expect(row.classification).toBe('single');
  });

  it('keeps a 4-track album titled Singles visible', () => {
    seedAlbum(db, { id: 'a1', name: 'Singles', artist: 'Future', songCount: 4 });
    new LibraryCurator(db).reclassifyAll();
    const row = readRow(db, 'a1');
    expect(row.hidden).toBe(0);
    expect(row.classification).toBe('album');
  });

  it('matches Singles case-insensitively and trims whitespace', () => {
    seedAlbum(db, { id: 'a1', name: '  SINGLES ', artist: 'Babasónicos', songCount: 2 });
    new LibraryCurator(db).reclassifyAll();
    const row = readRow(db, 'a1');
    expect(row.hidden).toBe(1);
    expect(row.classification).toBe('single');
  });

  it('does not touch a Singles album with manual_override=1', () => {
    seedAlbum(db, {
      id: 'a1',
      name: 'Singles',
      artist: 'Babasónicos',
      songCount: 1,
      manualOverride: true,
      hidden: false,
      classification: 'album',
    });
    new LibraryCurator(db).reclassifyAll();
    const row = readRow(db, 'a1');
    expect(row.hidden).toBe(0);
    expect(row.classification).toBe('album');
  });

  it('leaves a normal multi-track album classified as album', () => {
    seedAlbum(db, { id: 'a1', name: 'Discovery', artist: 'Daft Punk', songCount: 14 });
    new LibraryCurator(db).reclassifyAll();
    const row = readRow(db, 'a1');
    expect(row.hidden).toBe(0);
    expect(row.classification).toBe('album');
  });

  it('keeps a deliberately-hunted thin release visible (protected by album_jobs)', () => {
    // A 2-track Singles-named bucket would normally be hidden, but a matching
    // hunt job marks it as deliberately acquired → it must stay visible.
    seedAlbum(db, { id: 'a1', name: 'Singles', artist: 'Babasónicos', songCount: 2 });
    seedJob(db, 'Babasónicos', 'Singles');
    new LibraryCurator(db).reclassifyAll();
    const row = readRow(db, 'a1');
    expect(row.hidden).toBe(0);
  });

  it('matches the protecting job by normalized artist+title (edition/diacritics insensitive)', () => {
    seedAlbum(db, { id: 'a1', name: 'Singles', artist: 'Babasonicos', songCount: 1 });
    seedJob(db, 'BABASÓNICOS', 'singles');
    new LibraryCurator(db).reclassifyAll();
    const row = readRow(db, 'a1');
    expect(row.hidden).toBe(0);
  });

  it('still hides a thin Singles bucket when no job matches', () => {
    seedAlbum(db, { id: 'a1', name: 'Singles', artist: 'Babasónicos', songCount: 2 });
    seedJob(db, 'Soda Stereo', 'Canción Animal');
    new LibraryCurator(db).reclassifyAll();
    const row = readRow(db, 'a1');
    expect(row.hidden).toBe(1);
  });
});
