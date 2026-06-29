import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { albumIdFor, artistIdFor } from './library-scanner.js';
import { albumAlreadyComplete, filesMissingOnDisk } from './library-completeness.js';

/** Seed a local album row plus its songs, using the real deterministic ids. */
function seedAlbum(
  db: Database,
  artist: string,
  album: string,
  songTitles: string[],
): { albumId: string } {
  const albumId = albumIdFor(artist, album);
  const artistId = artistIdFor(artist);
  db.run(
    `INSERT OR IGNORE INTO library_albums (id, name, artist, artist_id, song_count, synced_at)
     VALUES (?, ?, ?, ?, ?, 1)`,
    [albumId, album, artist, artistId, songTitles.length],
  );
  songTitles.forEach((title, i) => {
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, path, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [`${albumId}-${i}`, albumId, title, artist, artistId, `/m/${albumId}-${i}.flac`],
    );
  });
  return { albumId };
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

  it('drops files whose track is already on disk (partial album, grouping match)', () => {
    seedAlbum(db, 'Soda Stereo', 'Dynamo', ['One']);
    const missing = filesMissingOnDisk(db, 'Soda Stereo', 'Dynamo', files);
    expect(missing.map((f) => f.filename)).toEqual(['02 Two.flac', '03 Three.flac']);
  });

  it('returns an empty list when every track is already on disk', () => {
    seedAlbum(db, 'Soda Stereo', 'Dynamo', ['One', 'Two', 'Three']);
    expect(filesMissingOnDisk(db, 'Soda Stereo', 'Dynamo', files)).toEqual([]);
  });

  it('matches an edition folder of the album via the edition-collapsing grouping', () => {
    // The deluxe edition collapses to the same grouping key, so its tracks count.
    seedAlbum(db, 'Soda Stereo', 'Dynamo (Deluxe Edition)', ['One']);
    const missing = filesMissingOnDisk(db, 'Soda Stereo', 'Dynamo', files);
    expect(missing.map((f) => f.filename)).toEqual(['02 Two.flac', '03 Three.flac']);
  });

  it('uses the resolved localAlbumId when the canonical artist diverges from local tags', () => {
    // Local songs are tagged under the peer's artist spelling ("El Bahiano"); the
    // canonical Lidarr artist is "Bahiano". The grouping match (anchored on the
    // canonical artist id) can't find them, but the resolved localAlbumId can.
    const { albumId } = seedAlbum(db, 'El Bahiano', 'Cuando reina el Amor', ['One']);

    // Without the id: artist-tag divergence hides the on-disk track → re-downloads all.
    expect(filesMissingOnDisk(db, 'Bahiano', 'Cuando reina el Amor', files)).toEqual(files);

    // With the resolved local album id: the on-disk track is dropped precisely.
    const missing = filesMissingOnDisk(db, 'Bahiano', 'Cuando reina el Amor', files, albumId);
    expect(missing.map((f) => f.filename)).toEqual(['02 Two.flac', '03 Three.flac']);
  });

  it('falls back to the grouping match when the localAlbumId has no songs', () => {
    seedAlbum(db, 'Soda Stereo', 'Dynamo', ['One']);
    // A stale/empty id must not suppress the grouping fallback.
    const missing = filesMissingOnDisk(db, 'Soda Stereo', 'Dynamo', files, 'nonexistent-id');
    expect(missing.map((f) => f.filename)).toEqual(['02 Two.flac', '03 Three.flac']);
  });
});

describe('albumAlreadyComplete', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
  });

  it('is true only when song_count >= canonical track count', () => {
    db.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, synced_at)
       VALUES ('a', 'Dynamo', 'Soda Stereo', ?, 2, 1)`,
      [artistIdFor('Soda Stereo')],
    );
    expect(albumAlreadyComplete(db, 'Soda Stereo', 'Dynamo', 3)).toBe(false);
    expect(albumAlreadyComplete(db, 'Soda Stereo', 'Dynamo', 2)).toBe(true);
  });

  it('matches across artist-spelling divergence via artist identity + grouping', () => {
    // Local row tagged "Soda Stereo" with an accented/edition title; the query uses
    // a differently-cased artist and the base title — both fold to the same identity.
    db.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, synced_at)
       VALUES ('a', 'Canción Animal (Remasterizado)', 'Soda Stereo', ?, 9, 1)`,
      [artistIdFor('soda stereo')],
    );
    expect(albumAlreadyComplete(db, 'SODA STEREO', 'Cancion Animal', 9)).toBe(true);
  });
});
