import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { LibraryScanner } from './library-scanner.js';

let musicDir: string;
let db: Database;

beforeEach(() => {
  musicDir = mkdtempSync(join(tmpdir(), 'reconcile-test-'));
  db = new Database(':memory:');
  applySchema(db);
});

afterEach(() => {
  db.close();
  rmSync(musicDir, { recursive: true, force: true });
});

describe('reconcileAlbums', () => {
  it('rescans an album folder and prunes orphan song rows whose files no longer exist', async () => {
    // Arrange: one real audio file on disk
    const albumDir = join(musicDir, 'Artist', 'Album');
    mkdirSync(albumDir, { recursive: true });
    writeFileSync(join(albumDir, '01 - Kept.mp3'), Buffer.alloc(0));

    const scanner = new LibraryScanner(musicDir, db);

    // First reconcile: indexes the live file
    await scanner.reconcileAlbums([albumDir]);

    // The album must exist in the DB after the first reconcile
    const albumRow = db.query<{ id: string }, []>('SELECT id FROM library_albums LIMIT 1').get();
    expect(albumRow).not.toBeNull();
    const albumId = albumRow!.id;

    // Verify there is exactly one song after first reconcile
    const beforeCount = db
      .query<{ c: number }, [string]>('SELECT COUNT(*) AS c FROM library_songs WHERE album_id = ?')
      .get(albumId)!.c;
    expect(beforeCount).toBe(1);

    // Inject an orphan row pointing to a path that does not exist on disk
    db.run(
      `INSERT INTO library_songs
         (id, album_id, title, artist, artist_id, path, synced_at)
       VALUES
         ('orphan-song-id', ?, 'Ghost Track', 'Artist', 'fake-artist-id',
          'Artist/Album/ghost.mp3', 1)`,
      [albumId],
    );

    // Second reconcile: should detect that ghost.mp3 is absent and prune the row
    await scanner.reconcileAlbums([albumDir]);

    const allSongIds = db
      .query<{ id: string }, [string]>('SELECT id FROM library_songs WHERE album_id = ?')
      .all(albumId)
      .map((r) => r.id);

    expect(allSongIds).not.toContain('orphan-song-id');
    expect(allSongIds).toHaveLength(1); // the real file survives
  });

  it('keeps the album and live song intact after orphan prune', async () => {
    const albumDir = join(musicDir, 'Band', 'Record');
    mkdirSync(albumDir, { recursive: true });
    writeFileSync(join(albumDir, '01.mp3'), Buffer.alloc(0));

    const scanner = new LibraryScanner(musicDir, db);
    await scanner.reconcileAlbums([albumDir]);

    const albumId = db.query<{ id: string }, []>('SELECT id FROM library_albums LIMIT 1').get()!.id;

    // Orphan row
    db.run(
      `INSERT INTO library_songs
         (id, album_id, title, artist, artist_id, path, synced_at)
       VALUES ('o2', ?, 'Deleted', 'Band', 'x', 'Band/Record/gone.mp3', 1)`,
      [albumId],
    );

    await scanner.reconcileAlbums([albumDir]);

    const album = db
      .query<{ id: string; song_count: number }, [string]>(
        'SELECT id, song_count FROM library_albums WHERE id = ?',
      )
      .get(albumId);

    // Album must still exist (the live file keeps it alive)
    expect(album).not.toBeNull();
    // song_count should reflect only the surviving real file
    expect(album!.song_count).toBe(1);
  });

  it('completes without error when an album dir is empty after file deletion', async () => {
    const albumDir = join(musicDir, 'Solo', 'EP');
    mkdirSync(albumDir, { recursive: true });
    // Write a real file, scan it, then DELETE the file (simulating organizer removal)
    const realFile = join(albumDir, '01.mp3');
    writeFileSync(realFile, Buffer.alloc(0));

    const scanner = new LibraryScanner(musicDir, db);
    await scanner.reconcileAlbums([albumDir]);

    // Delete the file from disk
    rmSync(realFile);

    // reconcileAlbums with the now-empty dir: walk returns nothing, so we
    // cannot get album ids from built.albums. This case is intentionally not
    // expected to prune (the caller should only pass dirs that still have
    // surviving files), so we just verify the function completes without error.
    await scanner.reconcileAlbums([albumDir]);
    // No assertion needed beyond "no throw"
  });
});

// Issue #776: a canonical Lidarr tracklist is pinned in `album_jobs` at download
// time and consulted on EVERY later rescan. After a curator cleans a title the
// file stops matching that tracklist, so it was dropped from the scan as a
// "foreign rip" — never reaching persist, leaving library_songs stale forever.
// Prod repro: Juanes — Un Día Normal (20th Anniversary), 2026-08-27.
describe('reconcileAlbums — a pinned canonical tracklist cannot veto a curator retag', () => {
  it('still refreshes a song row whose title no longer matches the canonical list', async () => {
    const albumDir = join(musicDir, 'Juanes', 'Un Dia Normal');
    mkdirSync(albumDir, { recursive: true });
    writeFileSync(join(albumDir, '02 - Es Por Ti.mp3'), Buffer.alloc(0));

    const scanner = new LibraryScanner(musicDir, db);
    await scanner.reconcileAlbums([albumDir]);

    const song = db
      .query<{ id: string; title: string }, []>('SELECT id, title FROM library_songs LIMIT 1')
      .get();
    expect(song).not.toBeNull();
    const scannedTitle = song!.title;
    // Pin the tracklist to the album the scanner actually minted — the job's
    // artist/album must hash to the same `albumIdFor`, or the canonical list
    // silently never applies and this test proves nothing.
    const album = db
      .query<{ name: string; artist: string }, []>(
        'SELECT name, artist FROM library_albums LIMIT 1',
      )
      .get()!;

    // The album is now pinned to a tracklist the file's title does NOT satisfy:
    // titlesOverlap counts canonical words present in the file title, so the
    // shorter cleaned title scores 3/5 = 0.6, under the 0.7 threshold.
    db.run(
      `INSERT INTO album_jobs
         (username, directory, canonical_tracks_json, alternates_json, created_at,
          artist_name, album_title)
       VALUES ('peer', ?, ?, '[]', 1, ?, ?)`,
      [albumDir, JSON.stringify([`${scannedTitle} (Remastered 2022)`]), album.artist, album.name],
    );

    // Simulate the stale row the bug leaves behind, then rescan.
    db.run('UPDATE library_songs SET title = ? WHERE id = ?', ['STALE TITLE', song!.id]);
    await scanner.reconcileAlbums([albumDir]);

    const after = db
      .query<{ title: string }, [string]>('SELECT title FROM library_songs WHERE id = ?')
      .get(song!.id);
    expect(after?.title).toBe(scannedTitle);
  });
});
