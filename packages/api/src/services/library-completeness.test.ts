import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { albumIdFor } from './library-scanner.js';
import { albumAlreadyComplete, filesMissingOnDisk } from './library-completeness.js';

function seedSong(db: Database, artist: string, album: string, title: string, id: string): void {
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, path, synced_at)
     VALUES (?, ?, ?, ?, 'art', ?, 1)`,
    [id, albumIdFor(artist, album), title, artist, `/m/${id}.flac`],
  );
}

describe('filesMissingOnDisk', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
  });

  const files = [
    { filename: '01 One.flac', size: 1 },
    { filename: '02 Two.flac', size: 1 },
    { filename: '03 Three.flac', size: 1 },
  ];

  it('returns all files when the album is not on disk yet (fresh hunt)', () => {
    expect(filesMissingOnDisk(db, 'Soda Stereo', 'Dynamo', files)).toEqual(files);
  });

  it('drops files whose track is already on disk (partial album)', () => {
    seedSong(db, 'Soda Stereo', 'Dynamo', 'One', 's1');
    const missing = filesMissingOnDisk(db, 'Soda Stereo', 'Dynamo', files);
    expect(missing.map((f) => f.filename)).toEqual(['02 Two.flac', '03 Three.flac']);
  });

  it('returns an empty list when every track is already on disk', () => {
    seedSong(db, 'Soda Stereo', 'Dynamo', 'One', 's1');
    seedSong(db, 'Soda Stereo', 'Dynamo', 'Two', 's2');
    seedSong(db, 'Soda Stereo', 'Dynamo', 'Three', 's3');
    expect(filesMissingOnDisk(db, 'Soda Stereo', 'Dynamo', files)).toEqual([]);
  });

  it('matches an edition folder of the album via the shared grouping id', () => {
    // The deluxe edition collapses to the same album id, so its tracks count.
    seedSong(db, 'Soda Stereo', 'Dynamo (Deluxe Edition)', 'One', 's1');
    const missing = filesMissingOnDisk(db, 'Soda Stereo', 'Dynamo', files);
    expect(missing.map((f) => f.filename)).toEqual(['02 Two.flac', '03 Three.flac']);
  });
});

describe('albumAlreadyComplete (regression)', () => {
  it('is true only when song_count >= canonical track count', () => {
    const db = new Database(':memory:');
    applySchema(db);
    db.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, synced_at)
       VALUES ('a', 'Dynamo', 'Soda Stereo', 'art', 2, 1)`,
    );
    expect(albumAlreadyComplete(db, 'Soda Stereo', 'Dynamo', 3)).toBe(false);
    expect(albumAlreadyComplete(db, 'Soda Stereo', 'Dynamo', 2)).toBe(true);
  });
});
