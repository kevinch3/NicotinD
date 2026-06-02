import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  buildLibrary,
  songId,
  albumIdFor,
  LibraryScanner,
  type ScannedTrack,
} from './library-scanner.js';

function track(p: Partial<ScannedTrack> & { relPath: string }): ScannedTrack {
  return {
    size: 1000,
    mtimeMs: Date.parse('2026-01-01T00:00:00Z'),
    suffix: 'mp3',
    contentType: 'audio/mpeg',
    duration: 200,
    bitRate: 320,
    ...p,
  };
}

describe('buildLibrary (pure aggregation)', () => {
  it('groups tracks into albums + artists and mints stable ids', () => {
    const built = buildLibrary([
      track({ relPath: 'Daft Punk/Discovery/01.mp3', artist: 'Daft Punk', album: 'Discovery', title: 'One More Time', track: 1 }),
      track({ relPath: 'Daft Punk/Discovery/02.mp3', artist: 'Daft Punk', album: 'Discovery', title: 'Aerodynamic', track: 2 }),
    ]);

    expect(built.songs).toHaveLength(2);
    expect(built.albums).toHaveLength(1);
    expect(built.artists).toHaveLength(1);
    expect(built.albums[0]!.songCount).toBe(2);
    expect(built.albums[0]!.duration).toBe(400);
    expect(built.albums[0]!.id).toBe(albumIdFor('Daft Punk', 'Discovery'));
    expect(built.songs[0]!.id).toBe(songId('Daft Punk/Discovery/01.mp3'));
    expect(built.songs[0]!.albumId).toBe(built.albums[0]!.id);
    expect(built.artists[0]!.albumCount).toBe(1);
  });

  it('keys album/artist cover ids on the group id so canonical artwork resolves', () => {
    const built = buildLibrary([
      track({ relPath: 'A/Alb/01.mp3', artist: 'A', album: 'Alb', title: 'T', track: 1 }),
    ]);
    // Album cover id == album id; artist cover id == artist id (so the cover
    // route can look canonical artwork up by these ids); songs keep their own id.
    expect(built.albums[0]!.coverArt).toBe(built.albums[0]!.id);
    expect(built.artists[0]!.coverArt).toBe(built.artists[0]!.id);
    expect(built.songs[0]!.coverArt).toBe(built.songs[0]!.id);
  });

  it('collapses edition variants into one album via the group key', () => {
    const built = buildLibrary([
      track({ relPath: 'A/Album/01.mp3', artist: 'A', album: 'Circus', title: 'T1' }),
      track({ relPath: 'A/Album (Deluxe Edition)/01.mp3', artist: 'A', album: 'Circus (Deluxe Edition)', title: 'T2' }),
    ]);
    // Both editions share a group key → one album id; display name is the shortest.
    expect(built.albums).toHaveLength(1);
    expect(built.albums[0]!.name).toBe('Circus');
    expect(built.albums[0]!.songCount).toBe(2);
  });

  it('infers album from the folder leaf when the album tag is missing', () => {
    const built = buildLibrary([
      track({ relPath: 'Some Artist/Greatest Hits/01.mp3', artist: 'Some Artist', title: 'Hit', album: undefined }),
    ]);
    expect(built.albums[0]!.name).toBe('Greatest Hits');
  });

  it('falls back to Unknown Artist/Album and a filename-derived title with no tags', () => {
    const built = buildLibrary([track({ relPath: 'loose-file.mp3' })]);
    expect(built.songs[0]!.artist).toBe('Unknown Artist');
    expect(built.songs[0]!.title).toBe('loose-file');
  });
});

describe('LibraryScanner.persist', () => {
  let db: Database;
  let scanner: LibraryScanner;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    scanner = new LibraryScanner('/music', db);
  });

  it('writes albums + songs and prunes vanished rows on a full scan', () => {
    const built = buildLibrary([
      track({ relPath: 'A/Album/01.mp3', artist: 'A', album: 'Album', title: 'T1' }),
    ]);
    scanner.persist(built, Date.now(), true);
    expect(db.query('SELECT COUNT(*) AS c FROM library_songs').get()).toEqual({ c: 1 });
    expect(db.query('SELECT COUNT(*) AS c FROM library_albums').get()).toEqual({ c: 1 });

    // A later full scan that no longer reports the file prunes it.
    scanner.persist({ songs: [], albums: [], artists: [], genres: [] }, Date.now() + 1, true);
    expect(db.query('SELECT COUNT(*) AS c FROM library_songs').get()).toEqual({ c: 0 });
    expect(db.query('SELECT COUNT(*) AS c FROM library_albums').get()).toEqual({ c: 0 });
  });

  it('preserves curation columns (hidden/classification) across rescans', () => {
    const built = buildLibrary([
      track({ relPath: 'A/Album/01.mp3', artist: 'A', album: 'Album', title: 'T1' }),
    ]);
    scanner.persist(built, Date.now(), true);
    const albumId = built.albums[0]!.id;
    db.run('UPDATE library_albums SET hidden = 1, classification = ?, manual_override = 1 WHERE id = ?', ['single', albumId]);

    // Rescan the same file — curation must stick.
    scanner.persist(built, Date.now() + 1, true);
    const row = db.query<{ hidden: number; classification: string }, [string]>(
      'SELECT hidden, classification FROM library_albums WHERE id = ?',
    ).get(albumId);
    expect(row?.hidden).toBe(1);
    expect(row?.classification).toBe('single');
  });

  it('incremental persist does not prune untouched rows', () => {
    scanner.persist(
      buildLibrary([track({ relPath: 'A/Album/01.mp3', artist: 'A', album: 'Album', title: 'T1' })]),
      Date.now(),
      true,
    );
    // A separate incremental batch for a different album must not drop the first.
    scanner.persist(
      buildLibrary([track({ relPath: 'B/Other/01.mp3', artist: 'B', album: 'Other', title: 'T2' })]),
      Date.now() + 1,
      false,
    );
    expect(db.query('SELECT COUNT(*) AS c FROM library_songs').get()).toEqual({ c: 2 });
  });
});
