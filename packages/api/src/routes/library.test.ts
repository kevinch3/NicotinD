import { describe, expect, it, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import * as realFsNamespace from 'node:fs';

// Snapshot the real node:fs BEFORE we mock it, so we can restore it afterward.
// Bun's mock.module is process-global and not auto-restored, so without this the
// partial stub below leaks into later test files (e.g. library-organizer.test.ts),
// leaving their mkdirSync/copyFileSync/etc. undefined and silently breaking them.
const realFs = { ...realFsNamespace };
import { libraryRoutes } from './library.js';
import type { AuthEnv } from '../middleware/auth.js';

import { applySchema } from '../db.js';

const sharedDb = new Database(':memory:');
applySchema(sharedDb);

mock.module('../db.js', () => ({
  getDatabase: () => sharedDb,
  applySchema,
}));

const fsState = new Map<string, boolean>();
const dirEntries = new Map<
  string,
  Array<{ name: string; isFile: boolean; isDirectory: boolean }>
>();

mock.module('node:fs', () => ({
  existsSync: (path: string) => fsState.get(path) ?? false,
  readdirSync: (path: string) =>
    (dirEntries.get(path) ?? []).map((entry) => ({
      name: entry.name,
      isFile: () => entry.isFile,
      isDirectory: () => entry.isDirectory,
    })),
  unlinkSync: mock((path: string) => {
    if (!fsState.get(path)) {
      throw new Error(`ENOENT: no such file or directory, unlink '${path}'`);
    }
    fsState.delete(path);
  }),
  rmSync: mock((path: string) => {
    // Recursive removal: drop the dir, its listing, and everything beneath it.
    fsState.delete(path);
    dirEntries.delete(path);
    const prefix = path.endsWith('/') ? path : `${path}/`;
    for (const key of [...fsState.keys()]) if (key.startsWith(prefix)) fsState.delete(key);
    for (const key of [...dirEntries.keys()]) if (key.startsWith(prefix)) dirEntries.delete(key);
  }),
}));

// Restore the real node:fs once this file's tests finish, so the global mock
// doesn't bleed into other test files that rely on real filesystem behavior.
afterAll(() => {
  mock.module('node:fs', () => realFs);
});

// Seed a canonical library_songs row — deletion now sources the file path from
// the canonical tables (the native scanner is the source of truth; Navidrome is
// gone), so a song must exist here to be deletable.
function seedSong(id: string, path: string): void {
  sharedDb.run('DELETE FROM library_songs WHERE id = ?', [id]);
  sharedDb.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, synced_at)
     VALUES (?, 'alb', ?, 'Artist', 'art', 0, ?, 1000, 320, 'mp3', 'audio/mpeg', '2024-01-01', 1)`,
    [id, id, path],
  );
}

describe('library routes', () => {
  let app: Hono<AuthEnv>;

  beforeEach(() => {
    fsState.clear();
    dirEntries.clear();

    app = new Hono<AuthEnv>();
    app.use('*', (c, next) => {
      c.set('user', { sub: 'test-user', role: 'admin', iat: 0, exp: 9999999999 });
      return next();
    });
    app.route('/', libraryRoutes('/home/kevinch3/Music'));
  });

  it('deletes a song using its canonical path', async () => {
    seedSong('song-1', '/home/kevinch3/Music/Artist/Album/song.mp3');
    fsState.set('/home/kevinch3/Music/Artist/Album/song.mp3', true);

    const res = await app.request('/songs/song-1', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(fsState.has('/home/kevinch3/Music/Artist/Album/song.mp3')).toBe(false);
  });

  it('GET /untracked lists completed downloads with no relative_path', async () => {
    sharedDb.run(
      `INSERT INTO completed_downloads (transfer_key, username, directory, filename, relative_path, basename, completed_at)
       VALUES ('utk1', 'u', 'd', 'old.mp3', NULL, 'old.mp3', 1),
              ('trk1', 'u', 'd', 'new.mp3', 'A/B/new.mp3', 'new.mp3', 2)`,
    );

    const res = await app.request('/untracked');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; rows: Array<{ transferKey: string }> };
    expect(body.rows.some((r) => r.transferKey === 'utk1')).toBe(true);
    expect(body.rows.some((r) => r.transferKey === 'trk1')).toBe(false);

    sharedDb.run(`DELETE FROM completed_downloads WHERE transfer_key IN ('utk1','trk1')`);
  });

  it('GET /untracked is admin-only', async () => {
    const userApp = new Hono<AuthEnv>();
    userApp.use('*', (c, next) => {
      c.set('user', { sub: 'u', role: 'user', iat: 0, exp: 9999999999 });
      return next();
    });
    userApp.route('/', libraryRoutes('/home/kevinch3/Music'));
    const res = await userApp.request('/untracked');
    expect(res.status).toBe(403);
  });

  it('bulk deletes multiple songs', async () => {
    seedSong('s1', '/home/kevinch3/Music/A/a.mp3');
    seedSong('s2', '/home/kevinch3/Music/B/b.mp3');
    fsState.set('/home/kevinch3/Music/A/a.mp3', true);
    fsState.set('/home/kevinch3/Music/B/b.mp3', true);

    const res = await app.request('/songs/bulk-delete', {
      method: 'POST',
      body: JSON.stringify({ ids: ['s1', 's2'] }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as { deletedCount: number };
    expect(data.deletedCount).toBe(2);
    expect(fsState.has('/home/kevinch3/Music/A/a.mp3')).toBe(false);
    expect(fsState.has('/home/kevinch3/Music/B/b.mp3')).toBe(false);
  });

  it('resolves a renamed file in the same directory', async () => {
    seedSong('song-2', '/home/kevinch3/Music/Artist/Album/song.mp3');
    fsState.set('/home/kevinch3/Music/Artist/Album/song.mp3', false);
    fsState.set('/home/kevinch3/Music/Artist/Album/song_123.mp3', true);
    fsState.set('/home/kevinch3/Music/Artist/Album', true);
    dirEntries.set('/home/kevinch3/Music/Artist/Album', [
      { name: 'song_123.mp3', isFile: true, isDirectory: false },
    ]);

    const res = await app.request('/songs/song-2', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(fsState.has('/home/kevinch3/Music/Artist/Album/song_123.mp3')).toBe(false);
  });

  it('finds the real file when the library path is stale and the folder name changed', async () => {
    seedSong('song-3', "/home/kevinch3/Music/Bryn Terfel/We'll Keep A Welcome/06 - Calon Lân.mp3");

    fsState.set('/home/kevinch3/Music', true);
    fsState.set('/home/kevinch3/Music/Bryn Terfel - Keep A Welcome', true);
    fsState.set('/home/kevinch3/Music/Bryn Terfel - Keep A Welcome/06. Calon Lân.mp3', true);
    dirEntries.set('/home/kevinch3/Music', [
      { name: 'Bryn Terfel - Keep A Welcome', isFile: false, isDirectory: true },
    ]);
    dirEntries.set('/home/kevinch3/Music/Bryn Terfel - Keep A Welcome', [
      { name: '06. Calon Lân.mp3', isFile: true, isDirectory: false },
    ]);

    const res = await app.request('/songs/song-3', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(fsState.has('/home/kevinch3/Music/Bryn Terfel - Keep A Welcome/06. Calon Lân.mp3')).toBe(
      false,
    );
  });

  it('finds a file by filename tokens when tags are missing', async () => {
    seedSong(
      'song-4',
      '/home/kevinch3/Music/[Unknown Artist]/[Unknown Album]/13 - 14_CALON_LAN_639096876154326491.mp3',
    );

    fsState.set('/home/kevinch3/Music', true);
    fsState.set('/home/kevinch3/Music/CD2', true);
    fsState.set('/home/kevinch3/Music/CD2/14_CALON_LAN.MP3', true);
    dirEntries.set('/home/kevinch3/Music', [{ name: 'CD2', isFile: false, isDirectory: true }]);
    dirEntries.set('/home/kevinch3/Music/CD2', [
      { name: '14_CALON_LAN.MP3', isFile: true, isDirectory: false },
    ]);

    const res = await app.request('/songs/song-4', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(fsState.has('/home/kevinch3/Music/CD2/14_CALON_LAN.MP3')).toBe(false);
  });

  it('returns 404 when the song is not in the library', async () => {
    const res = await app.request('/songs/song-5', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('finds a file nested two levels deep (Artist/Album/track) via fuzzy search', async () => {
    seedSong('song-6', '/home/kevinch3/Music/Original Artist/Original Album/track.mp3');

    fsState.set('/home/kevinch3/Music', true);
    fsState.set('/home/kevinch3/Music/Renamed Artist', true);
    fsState.set('/home/kevinch3/Music/Renamed Artist/Renamed Album', true);
    fsState.set('/home/kevinch3/Music/Renamed Artist/Renamed Album/track.mp3', true);
    dirEntries.set('/home/kevinch3/Music', [
      { name: 'Renamed Artist', isFile: false, isDirectory: true },
    ]);
    dirEntries.set('/home/kevinch3/Music/Renamed Artist', [
      { name: 'Renamed Album', isFile: false, isDirectory: true },
    ]);
    dirEntries.set('/home/kevinch3/Music/Renamed Artist/Renamed Album', [
      { name: 'track.mp3', isFile: true, isDirectory: false },
    ]);

    const res = await app.request('/songs/song-6', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(fsState.has('/home/kevinch3/Music/Renamed Artist/Renamed Album/track.mp3')).toBe(false);
  });

  it('orphan delete: returns 200 and cleans DB when file is gone but library_songs row exists', async () => {
    seedSong('song-7', '/home/kevinch3/Music/Gone/track.mp3');

    const res = await app.request('/songs/song-7', { method: 'DELETE' });

    expect(res.status).toBe(200);
    const row = sharedDb.query(`SELECT id FROM library_songs WHERE id = 'song-7'`).get();
    expect(row).toBeNull();
  });
});

describe('downloading album suppression', () => {
  const testDb = new Database(':memory:');
  applySchema(testDb);

  // Override the module-level mock so this describe's getDatabase returns our testDb.
  beforeEach(() => {
    mock.module('../db.js', () => ({ getDatabase: () => testDb, applySchema }));
    // Clean up between tests
    testDb.run('DELETE FROM library_albums');
    testDb.run('DELETE FROM library_songs');
    testDb.run('DELETE FROM album_jobs');
  });

  function seedAlbumRecord(id: string, name: string, artist: string): void {
    testDb.run('DELETE FROM library_albums WHERE id = ?', [id]);
    testDb.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, classification, synced_at)
       VALUES (?, ?, ?, 'art', 3, 120, 'album', 1)`,
      [id, name, artist],
    );
  }

  function seedActiveJob(artist: string, album: string): void {
    testDb.run(
      `INSERT INTO album_jobs (lidarr_album_id, username, directory, artist_name, album_title, canonical_tracks_json, alternates_json, state, created_at)
       VALUES (1, 'peer', 'dir', ?, ?, '[]', '[]', 'active', 1)`,
      [artist, album],
    );
  }

  afterEach(() => {
    // Restore the shared DB mock for other describe blocks.
    mock.module('../db.js', () => ({ getDatabase: () => sharedDb, applySchema }));
  });

  it('hides albums from GET /albums while their job is active', async () => {
    seedAlbumRecord('album-1', 'Kiss Me Once', 'Kylie Minogue');
    seedAlbumRecord('album-2', 'Fever', 'Kylie Minogue');
    seedActiveJob('Kylie Minogue', 'Kiss Me Once');

    const testApp = new Hono<AuthEnv>();
    testApp.use('*', (c, next) => {
      c.set('user', { sub: 'u', role: 'user', iat: 0, exp: 9999999999 });
      return next();
    });
    testApp.route('/', libraryRoutes());

    const res = await testApp.request('/albums');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.some((a) => a.id === 'album-2')).toBe(true);
    expect(body.some((a) => a.id === 'album-1')).toBe(false);
  });

  it('suppresses albums with year-suffixed peer folder names matching an active job', async () => {
    // Peer saved folder as "Kiss Me Once (2014)" but job is for "Kiss Me Once"
    seedAlbumRecord('album-3', 'Kiss Me Once (2014)', 'Kylie Minogue');
    seedActiveJob('Kylie Minogue', 'Kiss Me Once');

    const testApp = new Hono<AuthEnv>();
    testApp.use('*', (c, next) => {
      c.set('user', { sub: 'u', role: 'user', iat: 0, exp: 9999999999 });
      return next();
    });
    testApp.route('/', libraryRoutes());

    const res = await testApp.request('/albums');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.some((a) => a.id === 'album-3')).toBe(false);
  });

  it('shows albums whose job is done', async () => {
    seedAlbumRecord('album-4', 'Kiss Me Once', 'Kylie Minogue');
    testDb.run(
      `INSERT INTO album_jobs (lidarr_album_id, username, directory, artist_name, album_title, canonical_tracks_json, alternates_json, state, created_at)
       VALUES (1, 'peer', 'dir', 'Kylie Minogue', 'Kiss Me Once', '[]', '[]', 'done', 1)`,
    );

    const testApp = new Hono<AuthEnv>();
    testApp.use('*', (c, next) => {
      c.set('user', { sub: 'u', role: 'user', iat: 0, exp: 9999999999 });
      return next();
    });
    testApp.route('/', libraryRoutes());

    const res = await testApp.request('/albums');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.some((a) => a.id === 'album-4')).toBe(true);
  });
});

describe('album deletion', () => {
  let app: Hono<AuthEnv>;

  function seedAlbum(albumId: string, songs: Array<{ id: string; path: string }>): void {
    sharedDb.run('DELETE FROM library_albums WHERE id = ?', [albumId]);
    sharedDb.run('DELETE FROM library_songs WHERE album_id = ?', [albumId]);
    sharedDb.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
       VALUES (?, ?, 'Artist', 'art-1', ?, 0, 1)`,
      [albumId, `Album ${albumId}`, songs.length],
    );
    for (const s of songs) {
      sharedDb.run(
        `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, synced_at)
         VALUES (?, ?, ?, 'Artist', 'art-1', 0, ?, 1000, 320, 'mp3', 'audio/mpeg', '2024-01-01', 1)`,
        [s.id, albumId, s.id, s.path],
      );
    }
  }

  const albumRowExists = (id: string) =>
    sharedDb.query(`SELECT id FROM library_albums WHERE id = ?`).get(id) !== null;

  beforeEach(() => {
    fsState.clear();
    dirEntries.clear();
    app = new Hono<AuthEnv>();
    app.use('*', (c, next) => {
      c.set('user', { sub: 'test-user', role: 'admin', iat: 0, exp: 9999999999 });
      return next();
    });
    app.route('/', libraryRoutes('/home/kevinch3/Music'));
  });

  it('removes the whole album folder (cover art + sidecars) and clears canonical rows', async () => {
    const dir = '/home/kevinch3/Music/Folder Artist/Folder Album';
    seedAlbum('del-folder', [
      { id: 'fld-1', path: `${dir}/01.mp3` },
      { id: 'fld-2', path: `${dir}/02.mp3` },
    ]);
    sharedDb.run(
      `INSERT INTO completed_downloads (transfer_key, username, directory, filename, relative_path, basename, completed_at, navidrome_id)
       VALUES ('tk-fld', 'u', 'd', '01.mp3', 'Folder Artist/Folder Album/01.mp3', '01.mp3', 1, 'fld-1')`,
    );
    fsState.set(`${dir}/01.mp3`, true);
    fsState.set(`${dir}/02.mp3`, true);
    fsState.set(`${dir}/cover.jpg`, true);
    fsState.set(`${dir}/album.nfo`, true);
    dirEntries.set(dir, [
      { name: '01.mp3', isFile: true, isDirectory: false },
      { name: '02.mp3', isFile: true, isDirectory: false },
      { name: 'cover.jpg', isFile: true, isDirectory: false },
      { name: 'album.nfo', isFile: true, isDirectory: false },
    ]);

    const res = await app.request('/albums/del-folder', { method: 'DELETE' });

    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; deletedCount: number; failedCount: number };
    expect(data.ok).toBe(true);
    expect(data.deletedCount).toBe(2);
    expect(data.failedCount).toBe(0);
    // The folder and everything in it (incl. cover art / .nfo) is gone.
    expect(fsState.has(`${dir}/cover.jpg`)).toBe(false);
    expect(fsState.has(`${dir}/01.mp3`)).toBe(false);
    // Canonical rows + completion history removed (synchronously — no tombstone
    // needed because the native scanner reads disk directly).
    expect(albumRowExists('del-folder')).toBe(false);
    expect(
      sharedDb.query(`SELECT id FROM library_songs WHERE album_id = 'del-folder'`).get(),
    ).toBeNull();
    expect(
      sharedDb
        .query(`SELECT transfer_key FROM completed_downloads WHERE navidrome_id = 'fld-1'`)
        .get(),
    ).toBeNull();
  });

  it('does not recursively delete a shared Singles folder — only the album track is removed', async () => {
    const dir = '/home/kevinch3/Music/Sing Artist/Singles';
    seedAlbum('del-singles', [{ id: 'sg-1', path: `${dir}/mine.mp3` }]);
    fsState.set(`${dir}/mine.mp3`, true);
    fsState.set(`${dir}/other-single.mp3`, true); // belongs to a different single
    dirEntries.set(dir, [
      { name: 'mine.mp3', isFile: true, isDirectory: false },
      { name: 'other-single.mp3', isFile: true, isDirectory: false },
    ]);

    const res = await app.request('/albums/del-singles', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(fsState.has(`${dir}/mine.mp3`)).toBe(false);
    // The sibling single survived — the Singles folder was not nuked.
    expect(fsState.has(`${dir}/other-single.mp3`)).toBe(true);
    expect(albumRowExists('del-singles')).toBe(false);
  });

  it('falls back to per-file delete when the folder holds a foreign audio file', async () => {
    const dir = '/home/kevinch3/Music/Foreign Artist/Shared Album';
    seedAlbum('del-foreign', [{ id: 'frn-1', path: `${dir}/mine.mp3` }]);
    fsState.set(`${dir}/mine.mp3`, true);
    fsState.set(`${dir}/stranger.mp3`, true); // not part of this album
    dirEntries.set(dir, [
      { name: 'mine.mp3', isFile: true, isDirectory: false },
      { name: 'stranger.mp3', isFile: true, isDirectory: false },
    ]);

    const res = await app.request('/albums/del-foreign', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(fsState.has(`${dir}/mine.mp3`)).toBe(false);
    expect(fsState.has(`${dir}/stranger.mp3`)).toBe(true);
  });

  it('is idempotent: clears rows with ok:true even when files are already gone', async () => {
    // depth-1 dir so the folder path is skipped and per-file orphan cleanup runs.
    seedAlbum('del-orphan', [{ id: 'orp-1', path: '/home/kevinch3/Music/Orphan/track.mp3' }]);

    const res = await app.request('/albums/del-orphan', { method: 'DELETE' });

    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; deletedCount: number };
    expect(data.ok).toBe(true);
    expect(albumRowExists('del-orphan')).toBe(false);
    expect(
      sharedDb.query(`SELECT id FROM library_songs WHERE album_id = 'del-orphan'`).get(),
    ).toBeNull();
  });

  it('reports genuinely undeletable tracks in failed[] but still clears the album row', async () => {
    // Canonical row points at a missing, unrecoverable file (depth-1 so the
    // folder-delete fast path is skipped and per-file deletion runs).
    seedAlbum('del-fail', [{ id: 'fail-song', path: '/home/kevinch3/Music/Lonely/x.mp3' }]);

    const res = await app.request('/albums/del-fail', { method: 'DELETE' });

    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      ok: boolean;
      failedCount: number;
      failed: Array<{ id: string }>;
    };
    // The file is gone but the canonical row exists → orphan cleanup succeeds,
    // so the delete is reported ok and the album row is cleared.
    expect(albumRowExists('del-fail')).toBe(false);
    expect(data.ok).toBe(true);
  });

  it('does not run the canonical scan inline on album delete', async () => {
    const dir = '/home/kevinch3/Music/Sync Artist/Sync Album';
    seedAlbum('del-nosync', [{ id: 'ns-1', path: `${dir}/01.mp3` }]);
    fsState.set(`${dir}/01.mp3`, true);
    dirEntries.set(dir, [{ name: '01.mp3', isFile: true, isDirectory: false }]);

    const runSync = mock(() => Promise.resolve());
    const localApp = new Hono<AuthEnv>();
    localApp.use('*', (c, next) => {
      c.set('user', { sub: 'test-user', role: 'admin', iat: 0, exp: 9999999999 });
      return next();
    });
    localApp.route('/', libraryRoutes('/home/kevinch3/Music', { runSync }));

    const res = await localApp.request('/albums/del-nosync', { method: 'DELETE' });

    expect(res.status).toBe(200);
    // Album delete removes canonical rows synchronously; it never needs a rescan.
    expect(runSync).not.toHaveBeenCalled();
    expect(albumRowExists('del-nosync')).toBe(false);
  });
});

describe('singles & EPs presentation', () => {
  const testDb = new Database(':memory:');
  applySchema(testDb);

  beforeEach(() => {
    testDb.run('DELETE FROM library_albums');
    testDb.run('DELETE FROM library_artists');
    mock.module('../db.js', () => ({ getDatabase: () => testDb, applySchema }));
  });

  afterEach(() => {
    mock.module('../db.js', () => ({ getDatabase: () => sharedDb, applySchema }));
  });

  function seedAlbum(id: string, name: string, artistId: string, classification: string): void {
    testDb.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, classification, hidden, synced_at)
       VALUES (?, ?, 'Alfredo Casero', ?, 1, 60, ?, 0, 1)`,
      [id, name, artistId, classification],
    );
  }

  function makeApp(): Hono<AuthEnv> {
    const testApp = new Hono<AuthEnv>();
    testApp.use('*', (c, next) => {
      c.set('user', { sub: 'u', role: 'user', iat: 0, exp: 9999999999 });
      return next();
    });
    testApp.route('/', libraryRoutes());
    return testApp;
  }

  it('GET /albums excludes singles and EPs', async () => {
    seedAlbum('full', 'Real Album', 'art', 'album');
    seedAlbum('comp', 'Greatest Hits', 'art', 'compilation');
    seedAlbum('sng', 'Loose Single', 'art', 'single');
    seedAlbum('ep', 'Some EP', 'art', 'ep');

    const body = (await (await makeApp().request('/albums')).json()) as Array<{ id: string }>;
    const ids = body.map((a) => a.id);
    expect(ids).toContain('full');
    expect(ids).toContain('comp');
    expect(ids).not.toContain('sng');
    expect(ids).not.toContain('ep');
  });

  it('GET /singles returns only singles and EPs', async () => {
    seedAlbum('full', 'Real Album', 'art', 'album');
    seedAlbum('sng', 'Loose Single', 'art', 'single');
    seedAlbum('ep', 'Some EP', 'art', 'ep');

    const body = (await (await makeApp().request('/singles')).json()) as Array<{ id: string }>;
    const ids = body.map((a) => a.id);
    expect(ids.sort()).toEqual(['ep', 'sng']);
  });

  it('GET /artists/:id splits albums from singlesAndEps', async () => {
    testDb.run(
      `INSERT INTO library_artists (id, name, album_count, synced_at) VALUES ('art', 'Alfredo Casero', 3, 1)`,
    );
    seedAlbum('full', 'Real Album', 'art', 'album');
    seedAlbum('sng', 'Loose Single', 'art', 'single');
    seedAlbum('ep', 'Some EP', 'art', 'ep');

    const body = (await (await makeApp().request('/artists/art')).json()) as {
      albums: Array<{ id: string }>;
      singlesAndEps: Array<{ id: string }>;
    };
    expect(body.albums.map((a) => a.id)).toEqual(['full']);
    expect(body.singlesAndEps.map((a) => a.id).sort()).toEqual(['ep', 'sng']);
  });
});
