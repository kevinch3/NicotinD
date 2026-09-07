/**
 * Unit specs for the folder-art scope predicate (#978). The interesting cases
 * are the two kinds of shared bucket — one named, one only visible from its
 * contents — and the path handling the range scan depends on.
 */
import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { folderArtBelongsToAlbum } from './album-folder.js';

let db: Database;

function song(id: string, albumId: string, path: string): void {
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, synced_at)
     VALUES (?, ?, 'T', 'A', 'art', 0, ?, 10, 320, 'mp3', 'audio/mpeg', '2024-01-01', 1)`,
    [id, albumId, path],
  );
}

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

describe('folderArtBelongsToAlbum', () => {
  it('accepts a directory holding exactly one album', () => {
    song('s1', 'alb', 'Aphex Twin/Drukqs/01.flac');
    song('s2', 'alb', 'Aphex Twin/Drukqs/02.flac');
    expect(folderArtBelongsToAlbum(db, 'Aphex Twin/Drukqs/01.flac')).toBe(true);
  });

  it('rejects a directory holding more than one album', () => {
    // The live bucket: unrelated singles sharing one folder, so a cover.jpg in
    // it is nobody's album art.
    song('s1', 'alb-a', 'Various Artists/Unknown/a.opus');
    song('s2', 'alb-b', 'Various Artists/Unknown/b.mp3');
    expect(folderArtBelongsToAlbum(db, 'Various Artists/Unknown/a.opus')).toBe(false);
  });

  it('rejects a Singles bucket that currently holds one album', () => {
    // Named, so it is a bucket before the count can show it.
    song('s1', 'alb', 'Solo/Singles/only.mp3');
    expect(folderArtBelongsToAlbum(db, 'Solo/Singles/only.mp3')).toBe(false);
    expect(folderArtBelongsToAlbum(db, 'Solo/singles/only.mp3')).toBe(false);
  });

  it('counts only tracks directly in the directory, not in sub-directories', () => {
    song('s1', 'alb', 'Artist/Album/01.mp3');
    song('s2', 'other', 'Artist/Album/Disc 2/01.mp3');
    expect(folderArtBelongsToAlbum(db, 'Artist/Album/01.mp3')).toBe(true);
  });

  it('is not confused by LIKE wildcards in a folder name', () => {
    // `100% Hits` and `100_Hits` both match a naive LIKE '100_ Hits/%' pattern;
    // the range scan compares bytes, so the neighbour cannot leak in.
    song('s1', 'alb-a', 'VA/100% Hits/01.mp3');
    song('s2', 'alb-b', 'VA/100X Hits/01.mp3');
    expect(folderArtBelongsToAlbum(db, 'VA/100% Hits/01.mp3')).toBe(true);
  });

  it('treats a directory with no scanned tracks as an album folder', () => {
    expect(folderArtBelongsToAlbum(db, 'Artist/Album/01.mp3')).toBe(true);
  });

  it('handles a track sitting at the library root', () => {
    song('s1', 'alb-a', 'loose-a.mp3');
    song('s2', 'alb-b', 'loose-b.mp3');
    expect(folderArtBelongsToAlbum(db, 'loose-a.mp3')).toBe(false);
  });
});
