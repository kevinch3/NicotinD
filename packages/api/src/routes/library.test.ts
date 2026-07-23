import { describe, expect, it, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import * as realFsNamespace from 'node:fs';

// Snapshot the real node:fs BEFORE we mock it, so we can restore it afterward.
// Bun's mock.module is process-global and not auto-restored, so without this the
// partial stub below leaks into later test files (e.g. library-organizer.test.ts),
// leaving their mkdirSync/copyFileSync/etc. undefined and silently breaking them.
const realFs = { ...realFsNamespace };
import { libraryRoutes, __resetDownloadSuppressionCache } from './library.js';
import type { AuthEnv } from '../middleware/auth.js';
import type { SlskdUserTransferGroup } from '@nicotind/core';
import type { SlskdRef } from '../index.js';

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
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, landed_at, synced_at)
     VALUES (?, 'alb', ?, 'Artist', 'art', 0, ?, 1000, 320, 'mp3', 'audio/mpeg', '2024-01-01', 1, 1)`,
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

  it('POST /artists/identity writes a user split decision and 200s', async () => {
    const res = await app.request('/artists/identity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rawName: 'Bob Marley, Peter Tosh',
        decision: 'split',
        members: ['Bob Marley', 'Peter Tosh'],
      }),
    });
    expect(res.status).toBe(200);
    const row = sharedDb
      .query<{ decision: string; source: string; members: string }, [string]>(
        `SELECT decision, source, members FROM library_artist_identity WHERE raw_name = ?`,
      )
      .get('Bob Marley, Peter Tosh');
    expect(row).toEqual({
      decision: 'split',
      source: 'user',
      members: JSON.stringify(['Bob Marley', 'Peter Tosh']),
    });
  });

  it('POST /artists/:id/genre writes a user artist override and 200s', async () => {
    sharedDb.run(
      `INSERT OR REPLACE INTO library_artists (id, name, album_count, synced_at) VALUES ('art-lar', 'Jos\u00e9 Larralde', 1, 1)`,
    );
    const res = await app.request('/artists/art-lar/genre', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ genres: 'Folclore;Chacarera', note: 'MB has nothing for him' }),
    });
    expect(res.status).toBe(200);
    const row = sharedDb
      .query<{ genres: string; source: string; status: string }, [string]>(
        `SELECT genres, source, status FROM library_genre_overrides WHERE scope = 'artist' AND key = ?`,
      )
      .get('jose larralde');
    expect(row).toEqual({ genres: 'Folclore;Chacarera', source: 'user', status: 'applied' });
  });

  it('DELETE /artists/:id/genre removes the override', async () => {
    sharedDb.run(
      `INSERT OR REPLACE INTO library_artists (id, name, album_count, synced_at) VALUES ('art-del', 'Delible', 1, 1)`,
    );
    await app.request('/artists/art-del/genre', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ genres: 'Rock' }),
    });
    const res = await app.request('/artists/art-del/genre', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(
      sharedDb
        .query(`SELECT 1 FROM library_genre_overrides WHERE scope = 'artist' AND key = 'delible'`)
        .all(),
    ).toEqual([]);
  });

  it('POST /artists/:id/genre 400s on an empty genre list and 404s on an unknown artist', async () => {
    sharedDb.run(
      `INSERT OR REPLACE INTO library_artists (id, name, album_count, synced_at) VALUES ('art-e', 'Empty', 1, 1)`,
    );
    const bad = await app.request('/artists/art-e/genre', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ genres: '  ;  ' }),
    });
    expect(bad.status).toBe(400);
    const missing = await app.request('/artists/nope/genre', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ genres: 'Rock' }),
    });
    expect(missing.status).toBe(404);
  });

  it('POST /artists/identity writes a user merge alias', async () => {
    const res = await app.request('/artists/identity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rawName: 'Snoop Dog', mergeInto: 'Snoop Dogg' }),
    });
    expect(res.status).toBe(200);
    const row = sharedDb
      .query<{ canonical_name: string; source: string }, [string]>(
        `SELECT canonical_name, source FROM library_artist_aliases WHERE alias_norm = ?`,
      )
      .get('snoop dog');
    expect(row).toEqual({ canonical_name: 'Snoop Dogg', source: 'user' });
  });

  it('POST /artists/identity renames an artist via an alias, allowing an equal-normalized diacritic fix', async () => {
    const res = await app.request('/artists/identity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Both spellings normalize to the same key — the merge guard would reject
      // this, but a rename must allow it (accent-only display correction).
      body: JSON.stringify({
        rawName: 'Los Áutenticos Decadentes',
        rename: 'Los Auténticos Decadentes',
      }),
    });
    expect(res.status).toBe(200);
    const row = sharedDb
      .query<{ canonical_name: string; source: string }, [string]>(
        `SELECT canonical_name, source FROM library_artist_aliases WHERE alias_norm = ?`,
      )
      .get('los autenticos decadentes');
    expect(row).toEqual({ canonical_name: 'Los Auténticos Decadentes', source: 'user' });
  });

  it('POST /artists/identity awaits the resync and reports it', async () => {
    const runSync = mock(() => Promise.resolve());
    const localApp = new Hono<AuthEnv>();
    localApp.use('*', (c, next) => {
      c.set('user', { sub: 'u', role: 'admin', iat: 0, exp: 9999999999 });
      return next();
    });
    localApp.route('/', libraryRoutes('/home/kevinch3/Music', { runSync }));
    const res = await localApp.request('/artists/identity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rawName: 'X', decision: 'single' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, resynced: true });
    expect(runSync).toHaveBeenCalledTimes(1);
  });

  it('POST /artists/identity validates its shapes', async () => {
    const post = (body: unknown) =>
      app.request('/artists/identity', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await post({})).status).toBe(400); // no rawName
    expect((await post({ rawName: 'X' })).status).toBe(400); // no decision/mergeInto
    expect((await post({ rawName: 'A & B', decision: 'split', members: ['A'] })).status).toBe(400); // <2 members
    expect((await post({ rawName: 'Same', mergeInto: 'same' })).status).toBe(400); // self-merge
    expect((await post({ rawName: 'X', rename: '' })).status).toBe(400); // empty rename
    expect((await post({ rawName: 'X', rename: 'X' })).status).toBe(400); // no-op rename
  });

  it('POST /artists/identity is admin-only', async () => {
    const userApp = new Hono<AuthEnv>();
    userApp.use('*', (c, next) => {
      c.set('user', { sub: 'u', role: 'user', iat: 0, exp: 9999999999 });
      return next();
    });
    userApp.route('/', libraryRoutes('/home/kevinch3/Music'));
    const res = await userApp.request('/artists/identity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rawName: 'X', decision: 'single' }),
    });
    expect(res.status).toBe(403);
  });

  it('POST /songs/:id/genre appends to the existing set instead of replacing it', async () => {
    seedSong('gsong', '/home/kevinch3/Music/A/B/g.mp3');
    // Existing multi-genre set (primary first).
    sharedDb.run(`DELETE FROM library_song_genres WHERE song_id = 'gsong'`);
    sharedDb.run(
      `INSERT INTO library_song_genres (song_id, genre, position) VALUES ('gsong','House',0),('gsong','Techno',1)`,
    );
    sharedDb.run(`UPDATE library_songs SET genre = 'House' WHERE id = 'gsong'`);

    const res = await app.request('/songs/gsong/genre', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ genre: 'Deep House' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      genre: 'House',
      genres: ['House', 'Techno', 'Deep House'],
    });
    const rows = sharedDb
      .query<{ genre: string }, [string]>(
        `SELECT genre FROM library_song_genres WHERE song_id = ? ORDER BY position`,
      )
      .all('gsong');
    expect(rows.map((r) => r.genre)).toEqual(['House', 'Techno', 'Deep House']);
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

  it('hides an album with an in-flight slskd transfer from /albums, shows it once settled', async () => {
    sharedDb.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, classification, synced_at)
       VALUES ('uv', 'Ultraviolence', 'Lana Del Rey', 'ldr', 12, 1000, 'album', 1)`,
    );
    const inFlight: SlskdUserTransferGroup[] = [
      {
        username: 'peer',
        directories: [
          {
            // A raw (non-album_jobs) grab; the edition qualifier collapses to the card.
            directory: 'Lana Del Rey\\Ultraviolence (Deluxe Edition)',
            fileCount: 1,
            files: [
              {
                id: 't1',
                username: 'peer',
                filename: '01 - Cruel World.flac',
                size: 1,
                state: 'InProgress',
                bytesTransferred: 0,
                averageSpeed: 0,
                percentComplete: 0,
              },
            ],
          },
        ],
      },
    ];
    const makeApp = (groups: SlskdUserTransferGroup[]) => {
      const a = new Hono<AuthEnv>();
      a.use('*', (c, next) => {
        c.set('user', { sub: 'u', role: 'admin', iat: 0, exp: 9999999999 });
        return next();
      });
      a.route(
        '/',
        libraryRoutes('/home/kevinch3/Music', {
          slskdRef: {
            current: { transfers: { getDownloads: async () => groups } },
          } as unknown as SlskdRef,
        }),
      );
      return a;
    };

    __resetDownloadSuppressionCache();
    const hidden = (await (await makeApp(inFlight).request('/albums')).json()) as Array<{
      id: string;
    }>;
    expect(hidden.some((al) => al.id === 'uv')).toBe(false);

    __resetDownloadSuppressionCache();
    const shown = (await (await makeApp([]).request('/albums')).json()) as Array<{ id: string }>;
    expect(shown.some((al) => al.id === 'uv')).toBe(true);

    sharedDb.run(`DELETE FROM library_albums WHERE id = 'uv'`);
  });

  it('filters /albums by the album-level licence aggregate and ships it in the DTO', async () => {
    sharedDb.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, classification, licence, synced_at)
       VALUES ('pd1', 'Free Sounds', 'VA', 'va', 5, 500, 'album', 'public-domain', 1),
              ('mix1', 'Mixed Rights', 'VA', 'va', 5, 500, 'album', NULL, 1)`,
    );

    __resetDownloadSuppressionCache();
    const pd = (await (await app.request('/albums?licence=public-domain')).json()) as Array<{
      id: string;
      licence?: string;
    }>;
    expect(pd.map((a) => a.id).sort()).toEqual(['pd1']);
    expect(pd[0]!.licence).toBe('public-domain');

    __resetDownloadSuppressionCache();
    const all = (await (await app.request('/albums')).json()) as Array<{
      id: string;
      licence?: string;
    }>;
    const mix = all.find((a) => a.id === 'mix1');
    expect(mix).toBeDefined();
    // A NULL aggregate (mixed/unknown) is absent from the DTO.
    expect(mix!.licence).toBeUndefined();

    sharedDb.run(`DELETE FROM library_albums WHERE id IN ('pd1', 'mix1')`);
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

  it('GET /songs/:id/acquisition returns provenance for a recorded song', async () => {
    seedSong('song-acq', 'Artist/Album/track.flac');
    sharedDb.run(
      `INSERT OR REPLACE INTO acquisitions (relative_path, method, source_ref, stage, started_at, completed_at)
       VALUES ('Artist/Album/track.flac', 'slskd', 'peerZ', 'done', 100, 200)`,
    );
    const res = await app.request('/songs/song-acq/acquisition');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      method: 'slskd',
      sourceRef: 'peerZ',
      acquiredAt: 200,
      storagePath: 'Artist/Album/track.flac',
    });
  });

  it('GET /songs/:id/acquisition returns null when unrecorded, 404 when unknown', async () => {
    seedSong('song-noacq', 'Artist/Album/none.flac');
    const ok = await app.request('/songs/song-noacq/acquisition');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toBeNull();

    const missing = await app.request('/songs/does-not-exist/acquisition');
    expect(missing.status).toBe(404);
  });

  it('GET /artists/by-name resolves a name to its artist id (diacritic-insensitive)', async () => {
    sharedDb.run('DELETE FROM library_artists');
    sharedDb.run(
      `INSERT INTO library_artists (id, name, album_count, synced_at) VALUES ('art-lp', 'La Portuaria', 1, 1)`,
    );

    const exact = await app.request('/artists/by-name?name=La%20Portuaria');
    expect(exact.status).toBe(200);
    expect(await exact.json()).toEqual({ id: 'art-lp' });

    // Accented query still resolves via the diacritic-folded fallback scan.
    const accented = await app.request('/artists/by-name?name=La%20Port%C3%BAaria');
    expect(accented.status).toBe(200);
    expect(await accented.json()).toEqual({ id: 'art-lp' });

    const miss = await app.request('/artists/by-name?name=Nonexistent%20Band');
    expect(miss.status).toBe(404);

    const blank = await app.request('/artists/by-name?name=');
    expect(blank.status).toBe(400);
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
    testDb.run('DELETE FROM acquisition_jobs');
    // The album-group-key suppression cache is memoized per-db with a short TTL;
    // clear it so each test sees the albums it just seeded, not a prior test's.
    __resetDownloadSuppressionCache();
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

  it('hides albums while a unified acquisition job with no album_jobs row is active (track-search/direct)', async () => {
    seedAlbumRecord('album-acq', 'So Good', 'Zara Larsson');
    testDb.run(
      `INSERT INTO acquisition_jobs (id, kind, method, state, stage, artist_name, album_title, created_at, updated_at)
       VALUES ('acq1', 'track-search', 'slskd', 'active', 'downloading', 'Zara Larsson', 'So Good', 1, 1)`,
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
    expect(body.some((a) => a.id === 'album-acq')).toBe(false);

    // Job finishes → album reappears.
    testDb.run(`UPDATE acquisition_jobs SET state = 'done' WHERE id = 'acq1'`);
    __resetDownloadSuppressionCache();
    const after = (await (await testApp.request('/albums')).json()) as Array<{ id: string }>;
    expect(after.some((a) => a.id === 'album-acq')).toBe(true);
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

  // Regression: the exclusion used to run *after* SQL LIMIT/OFFSET, shrinking a
  // page below its requested size. A paginating client advancing its offset by
  // the (short) returned length then re-fetched already-shown rows, rendering
  // the same album 2-3x. Excluding in SQL keeps each page full-size so paging
  // never overlaps. Here a downloading album sits mid-list while we page by 2.
  it('paginates without duplicates or premature truncation while a job is active', async () => {
    // 6 album-classified releases, alphabetical ids album-a..album-f.
    for (const [id, name] of [
      ['album-a', 'Aaa'],
      ['album-b', 'Bbb'],
      ['album-c', 'Ccc'],
      ['album-d', 'Ddd'],
      ['album-e', 'Eee'],
      ['album-f', 'Fff'],
    ] as const) {
      seedAlbumRecord(id, name, 'Artist');
    }
    // 'Ccc' is mid-list and actively downloading -> excluded everywhere.
    seedActiveJob('Artist', 'Ccc');

    const testApp = new Hono<AuthEnv>();
    testApp.use('*', (c, next) => {
      c.set('user', { sub: 'u', role: 'user', iat: 0, exp: 9999999999 });
      return next();
    });
    testApp.route('/', libraryRoutes());

    // Page through with size=2 (mirrors the client's offset accumulation).
    const seen: string[] = [];
    let offset = 0;
    for (let guard = 0; guard < 20; guard++) {
      const res = await testApp.request(`/albums?type=alphabeticalByName&size=2&offset=${offset}`);
      expect(res.status).toBe(200);
      const page = (await res.json()) as Array<{ id: string }>;
      if (page.length === 0) break;
      seen.push(...page.map((a) => a.id));
      offset += page.length;
      if (page.length < 2) break;
    }

    // No duplicates across pages.
    expect(new Set(seen).size).toBe(seen.length);
    // The downloading album is absent; every other album shows exactly once.
    expect(seen.sort()).toEqual(['album-a', 'album-b', 'album-d', 'album-e', 'album-f']);
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
        `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, landed_at, synced_at)
         VALUES (?, ?, ?, 'Artist', 'art-1', 0, ?, 1000, 320, 'mp3', 'audio/mpeg', '2024-01-01', 1, 1)`,
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

  it('gates album delete on the curator role (listener/user 403, refiner 200)', async () => {
    const appFor = (role: 'listener' | 'user' | 'refiner') => {
      const a = new Hono<AuthEnv>();
      a.use('*', (c, next) => {
        c.set('user', { sub: 'u', role, iat: 0, exp: 9999999999 });
        return next();
      });
      a.route('/', libraryRoutes('/home/kevinch3/Music'));
      return a;
    };

    // listener + user cannot curate → 403 before the album is touched.
    seedAlbum('del-gate', [{ id: 'gate-1', path: '/home/kevinch3/Music/G/A/01.mp3' }]);
    for (const role of ['listener', 'user'] as const) {
      const res = await appFor(role).request('/albums/del-gate', { method: 'DELETE' });
      expect(res.status).toBe(403);
      expect(albumRowExists('del-gate')).toBe(true);
    }

    // refiner can curate → the delete goes through.
    const dir = '/home/kevinch3/Music/G/A';
    fsState.set(`${dir}/01.mp3`, true);
    dirEntries.set(dir, [{ name: '01.mp3', isFile: true, isDirectory: false }]);
    const ok = await appFor('refiner').request('/albums/del-gate', { method: 'DELETE' });
    expect(ok.status).toBe(200);
    expect(albumRowExists('del-gate')).toBe(false);
  });

  it('removes the now-orphaned artist + artwork when its only release is deleted', async () => {
    const dir = '/home/kevinch3/Music/Orphan Artist/Only Album';
    seedAlbum('del-orphan', [{ id: 'orph-1', path: `${dir}/01.mp3` }]);
    // Point the seeded album/song at a dedicated artist id + a genre + artwork.
    sharedDb.run(
      `UPDATE library_albums SET artist_id = 'art-orphan', genre = 'Orphancore' WHERE id = 'del-orphan'`,
    );
    sharedDb.run(
      `UPDATE library_songs SET artist_id = 'art-orphan', genre = 'Orphancore' WHERE album_id = 'del-orphan'`,
    );
    sharedDb.run(
      `INSERT INTO library_artists (id, name, album_count, synced_at) VALUES ('art-orphan', 'Orphan Artist', 1, 1)`,
    );
    sharedDb.run(
      `INSERT INTO library_genres (name, song_count, album_count, synced_at) VALUES ('Orphancore', 1, 1, 1)`,
    );
    sharedDb.run(
      `INSERT INTO library_artwork (id, kind, cover_url, updated_at) VALUES ('del-orphan', 'album', 'http://x/a.jpg', 1), ('art-orphan', 'artist', 'http://x/b.jpg', 1)`,
    );
    fsState.set(`${dir}/01.mp3`, true);
    dirEntries.set(dir, [{ name: '01.mp3', isFile: true, isDirectory: false }]);

    const res = await app.request('/albums/del-orphan', { method: 'DELETE' });
    expect(res.status).toBe(200);

    // The orphaned artist no longer surfaces in search / on its own page,
    // and its empty genre + both artwork rows are gone.
    expect(
      sharedDb.query(`SELECT id FROM library_artists WHERE id = 'art-orphan'`).get(),
    ).toBeNull();
    expect(
      sharedDb.query(`SELECT name FROM library_genres WHERE name = 'Orphancore'`).get(),
    ).toBeNull();
    expect(
      sharedDb.query(`SELECT id FROM library_artwork WHERE id = 'del-orphan'`).get(),
    ).toBeNull();
    expect(
      sharedDb.query(`SELECT id FROM library_artwork WHERE id = 'art-orphan'`).get(),
    ).toBeNull();
  });

  it('keeps an artist (with a corrected album_count) when other releases remain', async () => {
    const dirA = '/home/kevinch3/Music/Multi Artist/Album A';
    const dirB = '/home/kevinch3/Music/Multi Artist/Album B';
    seedAlbum('del-multi-a', [{ id: 'ma-1', path: `${dirA}/01.mp3` }]);
    seedAlbum('del-multi-b', [{ id: 'mb-1', path: `${dirB}/01.mp3` }]);
    sharedDb.run(
      `UPDATE library_albums SET artist_id = 'art-multi' WHERE id IN ('del-multi-a', 'del-multi-b')`,
    );
    sharedDb.run(
      `UPDATE library_songs SET artist_id = 'art-multi' WHERE album_id IN ('del-multi-a', 'del-multi-b')`,
    );
    sharedDb.run(
      `INSERT INTO library_artists (id, name, album_count, synced_at) VALUES ('art-multi', 'Multi Artist', 2, 1)`,
    );
    fsState.set(`${dirA}/01.mp3`, true);
    dirEntries.set(dirA, [{ name: '01.mp3', isFile: true, isDirectory: false }]);

    const res = await app.request('/albums/del-multi-a', { method: 'DELETE' });
    expect(res.status).toBe(200);

    const artist = sharedDb
      .query<{ album_count: number }, []>(
        `SELECT album_count FROM library_artists WHERE id = 'art-multi'`,
      )
      .get();
    expect(artist).not.toBeNull();
    expect(artist?.album_count).toBe(1);
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

  it('GET /albums excludes singles, EPs, and compilations', async () => {
    seedAlbum('full', 'Real Album', 'art', 'album');
    seedAlbum('comp', 'Greatest Hits', 'art', 'compilation');
    seedAlbum('sng', 'Loose Single', 'art', 'single');
    seedAlbum('ep', 'Some EP', 'art', 'ep');

    const body = (await (await makeApp().request('/albums')).json()) as Array<{ id: string }>;
    const ids = body.map((a) => a.id);
    expect(ids).toContain('full');
    expect(ids).not.toContain('comp');
    expect(ids).not.toContain('sng');
    expect(ids).not.toContain('ep');
  });

  it('GET /compilations returns only compilations', async () => {
    seedAlbum('full', 'Real Album', 'art', 'album');
    seedAlbum('comp', 'Greatest Hits', 'art', 'compilation');
    seedAlbum('sng', 'Loose Single', 'art', 'single');

    const body = (await (await makeApp().request('/compilations')).json()) as Array<{ id: string }>;
    const ids = body.map((a) => a.id);
    expect(ids).toContain('comp');
    expect(ids).not.toContain('full');
    expect(ids).not.toContain('sng');
  });

  it('GET /singles returns only singles and EPs', async () => {
    seedAlbum('full', 'Real Album', 'art', 'album');
    seedAlbum('sng', 'Loose Single', 'art', 'single');
    seedAlbum('ep', 'Some EP', 'art', 'ep');

    const body = (await (await makeApp().request('/singles')).json()) as Array<{ id: string }>;
    const ids = body.map((a) => a.id);
    expect(ids.sort()).toEqual(['ep', 'sng']);
  });

  it('GET /artists hides Various Artists from the list', async () => {
    testDb.run(`DELETE FROM library_artists`);
    testDb.run(
      `INSERT INTO library_artists (id, name, album_count, synced_at) VALUES ('art', 'Real Artist', 1, 1)`,
    );
    testDb.run(
      `INSERT INTO library_artists (id, name, album_count, synced_at) VALUES ('va', 'Various Artists', 3, 1)`,
    );

    const body = (await (await makeApp().request('/artists')).json()) as Array<{ name: string }>;
    const names = body.map((a) => a.name);
    expect(names).toContain('Real Artist');
    expect(names).not.toContain('Various Artists');
  });

  it('GET /artists hides split-compound entities (members represent them)', async () => {
    testDb.run(`DELETE FROM library_artists`);
    testDb.run(
      `INSERT INTO library_artists (id, name, album_count, synced_at) VALUES ('m1', 'Charly García', 2, 1)`,
    );
    testDb.run(
      `INSERT INTO library_artists (id, name, album_count, split_compound, synced_at)
       VALUES ('cmp', 'Charly García y Luis Alberto Spinetta', 1, 1, 1)`,
    );

    const body = (await (await makeApp().request('/artists')).json()) as Array<{ name: string }>;
    const names = body.map((a) => a.name);
    expect(names).toContain('Charly García');
    expect(names).not.toContain('Charly García y Luis Alberto Spinetta');
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

describe('GET /artists/:id/songs (Songs tab)', () => {
  const testDb = new Database(':memory:');
  applySchema(testDb);

  beforeEach(() => {
    testDb.run('DELETE FROM library_songs');
    testDb.run('DELETE FROM library_albums');
    mock.module('../db.js', () => ({ getDatabase: () => testDb, applySchema }));
  });

  afterEach(() => {
    mock.module('../db.js', () => ({ getDatabase: () => sharedDb, applySchema }));
  });

  function seedAlbum(id: string, name: string): void {
    testDb.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, classification, hidden, synced_at)
       VALUES (?, ?, 'A', 'art', 1, 60, 'album', 0, 1)`,
      [id, name],
    );
  }

  function seedSong(
    id: string,
    opts: {
      title: string;
      artistId?: string;
      albumId?: string;
      created?: string;
      starred?: string | null;
      hidden?: number;
      track?: number;
    },
  ): void {
    testDb.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, track, duration, path, size, bit_rate, suffix, content_type, created, starred, hidden, landed_at, synced_at)
       VALUES (?, ?, ?, 'A', ?, ?, 0, ?, 1000, 320, 'mp3', 'audio/mpeg', ?, ?, ?, 1, 1)`,
      [
        id,
        opts.albumId ?? 'alb',
        opts.title,
        opts.artistId ?? 'art',
        opts.track ?? null,
        `Artist/Album/${id}.mp3`,
        opts.created ?? '2024-01-01',
        opts.starred ?? null,
        opts.hidden ?? 0,
      ],
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

  it('returns the artist’s non-hidden songs and excludes other artists', async () => {
    seedAlbum('alb', 'Album');
    seedSong('s1', { title: 'Alpha' });
    seedSong('s2', { title: 'Beta', hidden: 1 });
    seedSong('s3', { title: 'Other', artistId: 'other' });

    const body = (await (await makeApp().request('/artists/art/songs')).json()) as Array<{
      id: string;
    }>;
    expect(body.map((s) => s.id)).toEqual(['s1']);
  });

  it('filters to starred only when starred=true', async () => {
    seedAlbum('alb', 'Album');
    seedSong('s1', { title: 'Alpha', starred: null });
    seedSong('s2', { title: 'Beta', starred: '2024-02-02' });

    const all = (await (await makeApp().request('/artists/art/songs')).json()) as Array<{
      id: string;
    }>;
    expect(all.map((s) => s.id).sort()).toEqual(['s1', 's2']);

    const starred = (await (
      await makeApp().request('/artists/art/songs?starred=true')
    ).json()) as Array<{ id: string }>;
    expect(starred.map((s) => s.id)).toEqual(['s2']);
  });

  it('sorts by title when sort=title', async () => {
    seedAlbum('alb', 'Album');
    seedSong('s1', { title: 'Zebra', created: '2024-03-01' });
    seedSong('s2', { title: 'apple', created: '2024-01-01' });

    const body = (await (
      await makeApp().request('/artists/art/songs?sort=title')
    ).json()) as Array<{ title: string }>;
    expect(body.map((s) => s.title)).toEqual(['apple', 'Zebra']); // NOCASE
  });

  it('defaults to newest-first and paginates by size/offset', async () => {
    seedAlbum('alb', 'Album');
    seedSong('old', { title: 'Old', created: '2020-01-01' });
    seedSong('new', { title: 'New', created: '2024-01-01' });

    const newest = (await (await makeApp().request('/artists/art/songs')).json()) as Array<{
      id: string;
    }>;
    expect(newest.map((s) => s.id)).toEqual(['new', 'old']);

    const page2 = (await (
      await makeApp().request('/artists/art/songs?size=1&offset=1')
    ).json()) as Array<{ id: string }>;
    expect(page2.map((s) => s.id)).toEqual(['old']);
  });
});

describe('library metadata filters', () => {
  const testDb = new Database(':memory:');
  applySchema(testDb);

  beforeEach(() => {
    testDb.run('DELETE FROM library_songs');
    testDb.run('DELETE FROM library_albums');
    testDb.run('DELETE FROM library_artists');
    testDb.run('DELETE FROM library_song_artists');
    // The download/quarantine suppression caches are keyed by db instance and
    // outlive a single test; clear them so a prior test's "nothing quarantined"
    // snapshot can't leak into one that seeds quarantined rows.
    __resetDownloadSuppressionCache();
    mock.module('../db.js', () => ({ getDatabase: () => testDb, applySchema }));
  });

  afterEach(() => {
    mock.module('../db.js', () => ({ getDatabase: () => sharedDb, applySchema }));
  });

  function seedAlbum(
    id: string,
    opts: { classification?: string; starred?: string | null; year?: number | null } = {},
  ): void {
    testDb.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, year, created, starred, classification, hidden, synced_at)
       VALUES (?, ?, 'A', 'art', 1, 60, ?, '2024-01-01', ?, ?, 0, 1)`,
      [id, `Album ${id}`, opts.year ?? null, opts.starred ?? null, opts.classification ?? 'album'],
    );
  }

  function seedArtist(id: string, opts: { starred?: string | null } = {}): void {
    testDb.run(
      `INSERT INTO library_artists (id, name, album_count, starred, hidden, synced_at)
       VALUES (?, ?, 1, ?, 0, 1)`,
      [id, `Artist ${id}`, opts.starred ?? null],
    );
  }

  function seedSong(
    id: string,
    opts: {
      albumId?: string;
      artistId?: string;
      bpm?: number | null;
      key?: string | null;
      energy?: number | null;
      mood?: string | null;
      genre?: string | null;
      year?: number | null;
      duration?: number;
      starred?: string | null;
    } = {},
  ): void {
    testDb.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, year, genre, path, created, starred, hidden, bpm, key, energy, mood, landed_at, synced_at)
       VALUES (?, ?, ?, 'A', ?, ?, ?, ?, ?, '2024-01-01', ?, 0, ?, ?, ?, ?, 1, 1)`,
      [
        id,
        opts.albumId ?? 'alb',
        `Song ${id}`,
        opts.artistId ?? 'art',
        opts.duration ?? 200,
        opts.year ?? null,
        opts.genre ?? null,
        `Artist/Album/${id}.mp3`,
        opts.starred ?? null,
        opts.bpm ?? null,
        opts.key ?? null,
        opts.energy ?? null,
        opts.mood ?? null,
      ],
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

  async function ids(path: string): Promise<string[]> {
    const res = await makeApp().request(path);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    return body.map((r) => r.id).sort();
  }

  it('GET /albums?energy=high matches albums where ANY track matches', async () => {
    seedAlbum('a-mixed');
    seedAlbum('a-calm');
    seedSong('s1', { albumId: 'a-mixed', energy: 0.9 });
    seedSong('s2', { albumId: 'a-mixed', energy: 0.1 });
    seedSong('s3', { albumId: 'a-calm', energy: 0.2 });

    expect(await ids('/albums?energy=high')).toEqual(['a-mixed']);
  });

  it('GET /albums?starred=true filters on album-level starred, not tracks', async () => {
    seedAlbum('a-star', { starred: '2024-01-01' });
    seedAlbum('a-plain');
    seedSong('s1', { albumId: 'a-star' });
    seedSong('s2', { albumId: 'a-plain', starred: '2024-01-01' }); // starred song, unstarred album

    expect(await ids('/albums?starred=true')).toEqual(['a-star']);
  });

  it('GET /albums?key=8A matches enharmonic key spellings', async () => {
    seedAlbum('a-am');
    seedAlbum('a-cmaj');
    seedSong('s1', { albumId: 'a-am', key: 'A minor' });
    seedSong('s2', { albumId: 'a-cmaj', key: 'C major' });

    expect(await ids('/albums?key=8A')).toEqual(['a-am']);
  });

  it('GET /albums with bpm + genre + year ranges combined', async () => {
    seedAlbum('a-hit');
    seedAlbum('a-miss');
    seedSong('s1', { albumId: 'a-hit', bpm: 125, genre: 'House', year: 1995 });
    seedSong('s2', { albumId: 'a-miss', bpm: 125, genre: 'House', year: 2005 });

    expect(await ids('/albums?bpmMin=120&bpmMax=130&genre=House&yearMax=1999')).toEqual(['a-hit']);
  });

  it('GET /singles and /compilations accept the same filter params', async () => {
    seedAlbum('single-fast', { classification: 'single' });
    seedAlbum('single-slow', { classification: 'single' });
    seedAlbum('comp-90s', { classification: 'compilation' });
    seedAlbum('comp-00s', { classification: 'compilation' });
    seedSong('f1', { albumId: 'single-fast', bpm: 160 });
    seedSong('f2', { albumId: 'single-slow', bpm: 80 });
    seedSong('c1', { albumId: 'comp-90s', year: 1994 });
    seedSong('c2', { albumId: 'comp-00s', year: 2004 });

    expect(await ids('/singles?bpmMin=140')).toEqual(['single-fast']);
    expect(await ids('/compilations?yearMax=1999')).toEqual(['comp-90s']);
  });

  it('GET /artists?mood=happy matches via the multi-artist join table', async () => {
    seedArtist('art-main');
    seedArtist('art-feat');
    seedArtist('art-none');
    seedSong('s1', { artistId: 'art-main', mood: 'happy' });
    testDb.run(
      `INSERT INTO library_song_artists (song_id, artist_id, role, position) VALUES ('s1', 'art-feat', 'featured', 1)`,
    );

    expect(await ids('/artists?mood=happy')).toEqual(['art-feat', 'art-main']);
  });

  it('GET /artists without filter params keeps its current behavior', async () => {
    seedArtist('art-a');
    seedArtist('art-b');

    expect(await ids('/artists')).toEqual(['art-a', 'art-b']);
  });

  it('GET /artists?starred=true filters on artist-level starred', async () => {
    seedArtist('art-star', { starred: '2024-01-01' });
    seedArtist('art-plain');
    seedSong('s1', { artistId: 'art-plain', starred: '2024-01-01' });

    expect(await ids('/artists?starred=true')).toEqual(['art-star']);
  });

  it('GET /artists/:id/songs applies song-level filters directly', async () => {
    seedAlbum('alb');
    seedSong('fast', { bpm: 150 });
    seedSong('slow', { bpm: 90 });
    seedSong('fast-other-artist', { artistId: 'other', bpm: 150 });

    expect(await ids('/artists/art/songs?bpmMin=120')).toEqual(['fast']);
  });

  it('ignores malformed filter values instead of failing', async () => {
    seedAlbum('a1');
    seedSong('s1', { albumId: 'a1' });

    expect(await ids('/albums?bpmMin=abc&mood=confused&energy=extreme')).toEqual(['a1']);
  });

  describe('landing-gate quarantine suppression', () => {
    /** Seed a quarantined song (landed_at NULL) directly, bypassing seedSong. */
    function seedQuarantined(id: string, albumId: string, artistId = 'art'): void {
      testDb.run(
        `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, created, hidden, synced_at)
         VALUES (?, ?, ?, 'A', ?, 0, ?, '2024-01-01', 0, 1)`,
        [id, albumId, `Song ${id}`, artistId, `A/Al/${id}.mp3`],
      );
    }

    it('hides an album from /albums until all its songs land', async () => {
      seedAlbum('a-live');
      seedAlbum('a-quar');
      seedSong('landed', { albumId: 'a-live' });
      seedSong('landed2', { albumId: 'a-quar' }); // one landed…
      seedQuarantined('pending', 'a-quar'); // …but one still processing

      // a-quar has an un-landed track → whole album hidden.
      expect(await ids('/albums')).toEqual(['a-live']);
    });

    it('reveals the album once its last song lands', async () => {
      seedAlbum('a1');
      seedSong('s-done', { albumId: 'a1' });
      seedQuarantined('s-pending', 'a1');
      expect(await ids('/albums')).toEqual([]);

      // Graduate the pending track.
      testDb.run(`UPDATE library_songs SET landed_at = 1 WHERE id = 's-pending'`);
      __resetDownloadSuppressionCache();
      expect(await ids('/albums')).toEqual(['a1']);
    });

    it('hides a quarantined-only album from /singles and /compilations', async () => {
      seedAlbum('sng', { classification: 'single' });
      seedAlbum('cmp', { classification: 'compilation' });
      seedQuarantined('s1', 'sng');
      seedQuarantined('c1', 'cmp');
      __resetDownloadSuppressionCache();

      expect(await ids('/singles')).toEqual([]);
      expect(await ids('/compilations')).toEqual([]);
    });

    it('omits quarantined songs from the artist Songs tab', async () => {
      seedAlbum('alb');
      seedSong('landed', { albumId: 'alb' });
      seedQuarantined('pending', 'alb');

      expect(await ids('/artists/art/songs')).toEqual(['landed']);
    });

    it('404s a quarantined album on direct fetch', async () => {
      seedAlbum('a1');
      seedQuarantined('s1', 'a1');
      __resetDownloadSuppressionCache();
      const res = await makeApp().request('/albums/a1');
      expect(res.status).toBe(404);
    });

    it('hides an artist whose only songs are all quarantined', async () => {
      seedArtist('ghost');
      seedArtist('real');
      seedAlbum('a-ghost');
      seedAlbum('a-real');
      seedQuarantined('g1', 'a-ghost', 'ghost');
      seedSong('r1', { albumId: 'a-real', artistId: 'real' });
      __resetDownloadSuppressionCache();

      expect(await ids('/artists')).toEqual(['real']);
    });
  });
});

describe('GET /fragments (library fragmentation diagnostic)', () => {
  const testDb = new Database(':memory:');
  applySchema(testDb);

  beforeEach(() => {
    testDb.run('DELETE FROM library_song_genres');
    testDb.run('DELETE FROM library_album_artists');
    testDb.run('DELETE FROM library_song_artists');
    testDb.run('DELETE FROM library_albums');
    testDb.run('DELETE FROM library_artists');
    mock.module('../db.js', () => ({ getDatabase: () => testDb, applySchema }));
  });

  afterEach(() => {
    mock.module('../db.js', () => ({ getDatabase: () => sharedDb, applySchema }));
  });

  function seedArtist(id: string, name: string, albumCount = 1): void {
    testDb.run(
      `INSERT INTO library_artists (id, name, album_count, synced_at) VALUES (?, ?, ?, 1)`,
      [id, name, albumCount],
    );
  }

  function seedAlbum(
    id: string,
    name: string,
    artist: string,
    artistId: string,
    options: { songCount?: number; classification?: string; hidden?: number } = {},
  ): void {
    testDb.run(
      `INSERT INTO library_albums
        (id, name, artist, artist_id, song_count, classification, hidden, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        id,
        name,
        artist,
        artistId,
        options.songCount ?? 5,
        options.classification ?? 'album',
        options.hidden ?? 0,
      ],
    );
  }

  it('reports ok:true when the library is clean', async () => {
    seedArtist('a1', 'Soda Stereo');
    seedAlbum('al1', 'Dynamo', 'Soda Stereo', 'a1', { songCount: 9, classification: 'album' });
    const app = new Hono<AuthEnv>();
    app.use('*', (c, next) => {
      c.set('user', { sub: 'u', role: 'admin', iat: 0, exp: 9999999999 });
      return next();
    });
    app.route('/', libraryRoutes());
    const res = await app.request('/fragments');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; totals: { duplicateAlbums: number } };
    expect(body.ok).toBe(true);
    expect(body.totals.duplicateAlbums).toBe(0);
  });

  it('detects an album split across artist spellings', async () => {
    // Real prod case: same release, artist tagged with a different apostrophe.
    // Both fold to "lakonga" but the scanner keeps the punctuation distinct.
    seedArtist('a1', 'La Konga');
    seedArtist('a2', "La K'onga");
    seedAlbum('al1', 'Universo Paralelo', 'La Konga', 'a1', { songCount: 4 });
    seedAlbum('al2', 'Universo Paralelo', "La K'onga", 'a2', { songCount: 5 });
    const app = new Hono<AuthEnv>();
    app.use('*', (c, next) => {
      c.set('user', { sub: 'u', role: 'admin', iat: 0, exp: 9999999999 });
      return next();
    });
    app.route('/', libraryRoutes());
    const res = await app.request('/fragments');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      duplicateAlbums: Array<{
        normalizedTitle: string;
        memberIds: string[];
        artistSpellings: Array<{ name: string; occurrences: number }>;
        totalSongs: number;
      }>;
      totals: { duplicateAlbums: number };
    };
    expect(body.ok).toBe(false);
    expect(body.totals.duplicateAlbums).toBe(1);
    expect(body.duplicateAlbums[0]!.normalizedTitle).toBe('universo paralelo');
    expect(body.duplicateAlbums[0]!.memberIds.sort()).toEqual(['al1', 'al2']);
    expect(body.duplicateAlbums[0]!.totalSongs).toBe(9);
    expect(body.duplicateAlbums[0]!.artistSpellings).toHaveLength(2);
  });

  it('403s for a non-admin caller', async () => {
    seedArtist('a1', 'Soda Stereo');
    seedAlbum('al1', 'Dynamo', 'Soda Stereo', 'a1', { songCount: 9, classification: 'album' });
    const app = new Hono<AuthEnv>();
    app.use('*', (c, next) => {
      c.set('user', { sub: 'u', role: 'user', iat: 0, exp: 9999999999 });
      return next();
    });
    app.route('/', libraryRoutes());
    const res = await app.request('/fragments');
    expect(res.status).toBe(403);
  });
});
