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
import type { Lidarr } from '@nicotind/lidarr-client';
import type { PluginRegistry } from '../services/plugins/registry.js';
import { getArtistMeta, upsertArtistMeta } from '../services/artist-meta-store.js';
import { getArtistOrigin, upsertArtistOrigin } from '../services/artist-origins.js';
import { getMbid, upsertMbid } from '../services/mbid-store.js';
import { normalizeArtistForGrouping } from '../services/album-grouping.js';
import { artistIdFor } from '../services/library-scanner.js';

import { applySchema } from '../db.js';
import { createJob } from '../services/acquisition-job-store.js';

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

  it('records an audit log entry on single-song delete (issue #336)', async () => {
    sharedDb.run(`DELETE FROM audit_log`);
    seedSong('song-audit', '/home/kevinch3/Music/Artist/Album/audit.mp3');
    fsState.set('/home/kevinch3/Music/Artist/Album/audit.mp3', true);

    const res = await app.request('/songs/song-audit', { method: 'DELETE' });
    expect(res.status).toBe(200);

    const rows = sharedDb
      .query<{ action: string; target_kind: string; target_id: string }, []>(
        `SELECT action, target_kind, target_id FROM audit_log`,
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'song.delete',
      target_kind: 'song',
      target_id: 'song-audit',
    });
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

  it('POST /artists/:id/genre defaults to append and honours an explicit replace', async () => {
    sharedDb.run(
      `INSERT OR REPLACE INTO library_artists (id, name, album_count, synced_at) VALUES ('art-tij', 'Ana Tijoux', 1, 1)`,
    );
    const modeOf = (): string | null =>
      sharedDb
        .query<{ mode: string | null }, [string]>(
          `SELECT mode FROM library_genre_overrides WHERE scope = 'artist' AND key = ?`,
        )
        .get('ana tijoux')?.mode ?? null;

    // No mode in the body — a fix must not destroy per-song genres by default.
    await app.request('/artists/art-tij/genre', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ genres: 'Hip Hop' }),
    });
    expect(modeOf()).toBe('append');

    const res = await app.request('/artists/art-tij/genre', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ genres: 'Hip Hop', mode: 'replace' }),
    });
    expect(res.status).toBe(200);
    expect(modeOf()).toBe('replace');
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
    expect(await res.json()).toEqual({
      ok: true,
      resynced: true,
      kind: 'single',
      artistId: artistIdFor('X'),
    });
    expect(runSync).toHaveBeenCalledTimes(1);
  });

  it('POST /artists/identity returns the resulting artist id + kind for each shape', async () => {
    // rename → land on the renamed artist
    const renamed = await app.request('/artists/identity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rawName: 'Wrong Name', rename: 'Right Name' }),
    });
    expect(await renamed.json()).toMatchObject({
      kind: 'renamed',
      artistId: artistIdFor('Right Name'),
    });

    // merge → land on the merge target
    const merged = await app.request('/artists/identity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rawName: 'Snoop Doggg', mergeInto: 'Snoop Dogg' }),
    });
    expect(await merged.json()).toMatchObject({
      kind: 'merged',
      artistId: artistIdFor('Snoop Dogg'),
    });

    // split → no single destination
    const split = await app.request('/artists/identity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rawName: 'A & B',
        decision: 'split',
        members: ['A', 'B'],
      }),
    });
    expect(await split.json()).toMatchObject({ kind: 'split', artistId: null });
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
    expect((await post({ rawName: 'Same', mergeInto: 'Same' })).status).toBe(400); // self-merge
    expect((await post({ rawName: 'X', rename: '' })).status).toBe(400); // empty rename
    expect((await post({ rawName: 'X', rename: 'X' })).status).toBe(400); // no-op rename
  });

  it('POST /artists/identity accepts a case/accent duplicate as a rename (#707)', async () => {
    // "Same" → "same" is one artist under two spellings, not two artists. It
    // used to be refused as a self-merge; it now routes to the rename path.
    const res = await app.request('/artists/identity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rawName: 'Héroes Del Silencio', mergeInto: 'Héroes del Silencio' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: 'renamed' });
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

  it('hides an album with an active acquisition job from /albums, shows it once settled', async () => {
    sharedDb.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, classification, synced_at)
       VALUES ('uv', 'Ultraviolence', 'Lana Del Rey', 'ldr', 12, 1000, 'album', 1)`,
    );
    // Since phase 3, download-suppression keys on the unified job ledger — an
    // active job for the artist/album hides the row, a finished one shows it.
    const jobId = createJob(sharedDb, {
      kind: 'album-hunt',
      method: 'slskd',
      artistName: 'Lana Del Rey',
      albumTitle: 'Ultraviolence',
      sourceRef: 'addon:slskd:aj-uv',
      files: [{ filename: '01 - Cruel World.flac', size: 1 }],
    });

    __resetDownloadSuppressionCache();
    const hidden = (await (await app.request('/albums')).json()) as Array<{ id: string }>;
    expect(hidden.some((al) => al.id === 'uv')).toBe(false);

    sharedDb.run(`UPDATE acquisition_jobs SET state = 'done' WHERE id = ?`, [jobId]);
    __resetDownloadSuppressionCache();
    const shown = (await (await app.request('/albums')).json()) as Array<{ id: string }>;
    expect(shown.some((al) => al.id === 'uv')).toBe(true);

    sharedDb.run(`DELETE FROM library_albums WHERE id = 'uv'`);
    sharedDb.run(`DELETE FROM acquisition_job_items`);
    sharedDb.run(`DELETE FROM acquisition_jobs`);
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

describe('genre-distribution routes (issue #222)', () => {
  let app: Hono<AuthEnv>;

  beforeEach(() => {
    app = new Hono<AuthEnv>();
    app.use('*', (c, next) => {
      c.set('user', { sub: 'test-user', role: 'admin', iat: 0, exp: 9999999999 });
      return next();
    });
    app.route('/', libraryRoutes('/home/kevinch3/Music'));
    sharedDb.run(`DELETE FROM library_albums WHERE id = 'gd-album'`);
    sharedDb.run(`DELETE FROM library_songs WHERE album_id = 'gd-album'`);
    sharedDb.run(`DELETE FROM library_song_genres WHERE song_id = 'gd-song'`);
    sharedDb.run(
      `INSERT OR REPLACE INTO library_artists (id, name, album_count, synced_at) VALUES ('gd-art', 'GD Artist', 1, 1)`,
    );
    sharedDb.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
       VALUES ('gd-album', 'GD Album', 'GD Artist', 'gd-art', 1, 0, 1)`,
    );
    sharedDb.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, landed_at, synced_at)
       VALUES ('gd-song', 'gd-album', 'GD Song', 'GD Artist', 'gd-art', 0, '/gd/song.mp3', 1000, 320, 'mp3', 'audio/mpeg', '2024-01-01', 1, 1)`,
    );
    sharedDb.run(
      `INSERT INTO library_song_genres (song_id, genre, position) VALUES ('gd-song', 'Rock', 0)`,
    );
  });

  it('GET /albums/:id/genre-distribution returns the album name + slices', async () => {
    const res = await app.request('/albums/gd-album/genre-distribution');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { album: string; slices: unknown[] };
    expect(body.album).toBe('GD Album');
    expect(body.slices).toEqual([{ genre: 'Rock', count: 1, weight: 1 }]);
  });

  it('GET /albums/:id/genre-distribution 404s for an unknown album', async () => {
    const res = await app.request('/albums/nonexistent/genre-distribution');
    expect(res.status).toBe(404);
  });

  it('GET /artists/:id/genre-distribution returns the artist name + slices', async () => {
    const res = await app.request('/artists/gd-art/genre-distribution');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artist: string; slices: unknown[] };
    expect(body.artist).toBe('GD Artist');
    expect(body.slices).toEqual([{ genre: 'Rock', count: 1, weight: 1 }]);
  });
});

// A genre's facet count and its detail listing must answer the SAME question.
// The scanner counts a song under every genre it carries (library_song_genres,
// all positions); the listing used to match only the mirrored primary column,
// so 397 of 764 prod genres counted >0 songs and opened to an empty page.
describe('GET /genres/songs (facet count and listing agree)', () => {
  let app: Hono<AuthEnv>;

  const song = (id: string, title: string, created: string, hidden = 0) =>
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size,
       bit_rate, suffix, content_type, created, landed_at, synced_at, hidden)
     VALUES ('${id}', 'gs-album', '${title}', 'GS Artist', 'gs-art', 0, '/gs/${id}.mp3', 1000,
       320, 'mp3', 'audio/mpeg', '${created}', 1, 1, ${hidden})`;

  beforeEach(() => {
    app = new Hono<AuthEnv>();
    app.use('*', (c, next) => {
      c.set('user', { sub: 'test-user', role: 'admin', iat: 0, exp: 9999999999 });
      return next();
    });
    app.route('/', libraryRoutes('/home/kevinch3/Music'));
    sharedDb.run(`DELETE FROM library_songs WHERE album_id = 'gs-album'`);
    sharedDb.run(`DELETE FROM library_albums WHERE id = 'gs-album'`);
    sharedDb.run(`DELETE FROM library_song_genres WHERE song_id LIKE 'gs-%'`);
    sharedDb.run(
      `INSERT OR REPLACE INTO library_artists (id, name, album_count, synced_at) VALUES ('gs-art', 'GS Artist', 1, 1)`,
    );
    sharedDb.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
       VALUES ('gs-album', 'GS Album', 'GS Artist', 'gs-art', 3, 0, 1)`,
    );

    // gs-secondary: 'Gabber' only at position 3 — the exact prod shape that
    // counted 1 song and listed none.
    sharedDb.run(song('gs-secondary', 'Secondary Only', '2024-03-01'));
    sharedDb.run(`UPDATE library_songs SET genre = 'Hardcore' WHERE id = 'gs-secondary'`);
    ['Hardcore', 'Techno', 'Industrial', 'Gabber'].forEach((g, i) => {
      sharedDb.run(
        `INSERT INTO library_song_genres (song_id, genre, position) VALUES ('gs-secondary', ?, ?)`,
        [g, i],
      );
    });

    // gs-primary: 'Gabber' at position 0, but OLDER than gs-secondary — so a
    // created-only sort would rank the secondary match above it.
    sharedDb.run(song('gs-primary', 'Primary Match', '2024-01-01'));
    sharedDb.run(`UPDATE library_songs SET genre = 'Gabber' WHERE id = 'gs-primary'`);
    sharedDb.run(
      `INSERT INTO library_song_genres (song_id, genre, position) VALUES ('gs-primary', 'Gabber', 0)`,
    );

    // gs-hidden: carries Gabber but is hidden — must stay out of the listing.
    sharedDb.run(song('gs-hidden', 'Hidden One', '2024-04-01', 1));
    sharedDb.run(
      `INSERT INTO library_song_genres (song_id, genre, position) VALUES ('gs-hidden', 'Gabber', 0)`,
    );
  });

  it('returns a song whose match is a SECONDARY genre (counted but unreachable)', async () => {
    const res = await app.request('/genres/songs?genre=Gabber');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.map((s) => s.id)).toContain('gs-secondary');
  });

  it('orders primary matches ahead of secondary ones, regardless of age', async () => {
    const res = await app.request('/genres/songs?genre=Gabber');
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.map((s) => s.id)).toEqual(['gs-primary', 'gs-secondary']);
  });

  it('still excludes hidden and un-landed songs', async () => {
    const res = await app.request('/genres/songs?genre=Gabber');
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.map((s) => s.id)).not.toContain('gs-hidden');
  });

  it('returns exactly as many songs as the facet counts (the invariant that broke)', async () => {
    // Mirror the scanner's rule: a song counts under every genre it carries.
    const facet = sharedDb
      .query<{ c: number }, [string]>(
        `SELECT COUNT(*) c FROM library_song_genres g
         JOIN library_songs s ON s.id = g.song_id
         WHERE g.genre = ? AND s.hidden = 0 AND s.landed_at IS NOT NULL`,
      )
      .get('Gabber')!.c;
    const res = await app.request('/genres/songs?genre=Gabber');
    const body = (await res.json()) as unknown[];
    expect(body.length).toBe(facet);
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

describe('GET /songs/autocomplete', () => {
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
    opts: { title: string; artist: string; albumId?: string; hidden?: number; landed?: boolean },
  ): void {
    testDb.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, hidden, landed_at, synced_at)
       VALUES (?, ?, ?, ?, 'art', 0, ?, 1000, 320, 'mp3', 'audio/mpeg', '2024-01-01', ?, ?, 1)`,
      [
        id,
        opts.albumId ?? 'alb',
        opts.title,
        opts.artist,
        `Artist/Album/${id}.mp3`,
        opts.hidden ?? 0,
        opts.landed === false ? null : 1,
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

  it('AND-matches every token across title + artist + album', async () => {
    seedAlbum('alb', 'Let It Be');
    seedSong('s1', { title: 'Let It Be', artist: 'The Beatles' });
    seedSong('s2', { title: 'The Wall', artist: 'Pink Floyd' }); // contains "the" only

    const body = (await (
      await makeApp().request('/songs/autocomplete?q=the+beatles')
    ).json()) as Array<{ id: string }>;
    expect(body.map((s) => s.id)).toEqual(['s1']);
  });

  it('caps limit at 25', async () => {
    seedAlbum('alb', 'Album');
    for (let i = 0; i < 30; i++) {
      seedSong(`s${i}`, { title: `Rock Song ${i}`, artist: 'Rock Band' });
    }
    const body = (await (
      await makeApp().request('/songs/autocomplete?q=rock&limit=100')
    ).json()) as Array<{ id: string }>;
    expect(body.length).toBe(25);
  });

  it('returns [] for an empty query', async () => {
    seedAlbum('alb', 'Album');
    seedSong('s1', { title: 'Alpha', artist: 'A' });
    const body = await (await makeApp().request('/songs/autocomplete?q=')).json();
    expect(body).toEqual([]);
  });

  it('ranks an exact title match ahead of a mere token match when capped by limit', async () => {
    seedAlbum('alb', 'Album');
    // Inserted first (and alphabetically first) so it would win an unsorted
    // slice — it only matches via its artist name, not its title.
    seedSong('artist-match', { title: 'Anthem', artist: 'Let It Be Tribute Band' });
    // Inserted second, but is the exact title match and must rank #1.
    seedSong('exact-match', { title: 'Let It Be', artist: 'The Beatles' });

    const body = (await (
      await makeApp().request('/songs/autocomplete?q=let+it+be&limit=1')
    ).json()) as Array<{ id: string }>;
    expect(body.map((s) => s.id)).toEqual(['exact-match']);
  });

  it('excludes hidden and quarantined (un-landed) songs', async () => {
    seedAlbum('alb', 'Album');
    seedSong('hidden', { title: 'Rock Anthem', artist: 'A', hidden: 1 });
    seedSong('quarantined', { title: 'Rock Anthem', artist: 'A', landed: false });
    seedSong('visible', { title: 'Rock Anthem', artist: 'A' });

    const body = (await (await makeApp().request('/songs/autocomplete?q=rock')).json()) as Array<{
      id: string;
    }>;
    expect(body.map((s) => s.id)).toEqual(['visible']);
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

    // Issue #693: a partly-landed album used to vanish entirely while its landed
    // tracks still showed in the artist Songs tab — so a downloaded album read as
    // a pile of orphan singles, which is the report that opened #687. It is now
    // shown and *marked* instead; only an album with nothing landed stays hidden,
    // because there is genuinely nothing to display.
    it('shows a partly-landed album, marked as processing', async () => {
      seedAlbum('a-live');
      seedAlbum('a-part');
      seedSong('landed', { albumId: 'a-live' });
      seedSong('landed2', { albumId: 'a-part' }); // one landed…
      seedQuarantined('pending', 'a-part'); // …one still processing
      __resetDownloadSuppressionCache();

      expect((await ids('/albums')).sort()).toEqual(['a-live', 'a-part']);

      const body = (await (await makeApp().request('/albums')).json()) as Array<{
        id: string;
        processingTracks?: number;
      }>;
      const byId = Object.fromEntries(body.map((a) => [a.id, a]));
      expect(byId['a-part'].processingTracks).toBe(1);
      expect(byId['a-live'].processingTracks ?? 0).toBe(0);
    });

    it('still hides an album with nothing landed at all', async () => {
      seedAlbum('a-none');
      seedQuarantined('p1', 'a-none');
      seedQuarantined('p2', 'a-none');
      __resetDownloadSuppressionCache();

      expect(await ids('/albums')).toEqual([]);
    });

    it('drops the processing mark once the last song lands', async () => {
      seedAlbum('a1');
      seedSong('s-done', { albumId: 'a1' });
      seedQuarantined('s-pending', 'a1');
      __resetDownloadSuppressionCache();
      expect(await ids('/albums')).toEqual(['a1']);

      // Graduate the pending track.
      testDb.run(`UPDATE library_songs SET landed_at = 1 WHERE id = 's-pending'`);
      __resetDownloadSuppressionCache();

      const body = (await (await makeApp().request('/albums')).json()) as Array<{
        id: string;
        processingTracks?: number;
      }>;
      expect(body[0].processingTracks ?? 0).toBe(0);
    });

    it('serves a partly-landed album on direct fetch, with its landed songs', async () => {
      seedAlbum('a1');
      seedSong('s-done', { albumId: 'a1' });
      seedQuarantined('s-pending', 'a1');
      __resetDownloadSuppressionCache();

      const res = await makeApp().request('/albums/a1');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        processingTracks?: number;
        song: Array<{ id: string }>;
      };
      expect(body.processingTracks).toBe(1);
      expect(body.song.map((s) => s.id)).toEqual(['s-done']);
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

    // The Downloads card's "Open in Library" link appears the moment a download
    // finishes — which is exactly when the album is still quarantined. Both the
    // quarantine hold and a genuinely absent album answered a bare
    // "Album not found", so the UI told the user their brand-new album did not
    // exist. The two must be tellable apart by `code` (the #337 convention).
    it('distinguishes a quarantined album from a genuinely missing one by code', async () => {
      seedAlbum('a1');
      seedQuarantined('s1', 'a1');
      __resetDownloadSuppressionCache();

      const quarantined = await makeApp().request('/albums/a1');
      expect(quarantined.status).toBe(404);
      expect(await quarantined.json()).toMatchObject({ code: 'ALBUM_PROCESSING' });

      const missing = await makeApp().request('/albums/does-not-exist');
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ code: 'ALBUM_NOT_FOUND' });
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

describe('artist-info routes', () => {
  const testDb = new Database(':memory:');
  applySchema(testDb);

  beforeEach(() => {
    testDb.run('DELETE FROM library_artist_meta');
    testDb.run('DELETE FROM library_mbids');
    testDb.run('DELETE FROM library_artists');
    mock.module('../db.js', () => ({ getDatabase: () => testDb, applySchema }));
  });

  afterEach(() => {
    mock.module('../db.js', () => ({ getDatabase: () => sharedDb, applySchema }));
  });

  function seedArtistWithAlbum(id = 'art-info', name = 'Info Artist'): string {
    testDb.run(
      `INSERT INTO library_artists (id, name, album_count, synced_at) VALUES (?, ?, 1, 1)`,
      [id, name],
    );
    return id;
  }

  /** A registry stub exposing only what refresh-info calls, mirroring
   * library.lyrics.test.ts's makeRegistry helper for the lyrics capability. */
  function makeRegistry(opts: {
    result?: { bio: string | null; urls: string[]; source: string; confidence: number } | null;
    enabled?: boolean;
    throws?: boolean;
  }): { registry: PluginRegistry; calls: () => number } {
    let calls = 0;
    const enabled = opts.enabled ?? true;
    const plugin = {
      artistInfo: {
        fetchArtistInfo: async () => {
          calls++;
          if (opts.throws) throw new Error('Discogs is down');
          return opts.result ?? null;
        },
      },
    };
    const registry = {
      hasCapability: () => enabled,
      getEnabledWithCapability: () => (enabled ? [plugin] : []),
    } as unknown as PluginRegistry;
    return { registry, calls: () => calls };
  }

  /** A Lidarr stub exposing only `artist.lookup`, returning one hit whose
   * normalized name matches `name` mapped to `mbid` (else an empty result). */
  function makeLidarr(entries: Record<string, string>): { lidarr: Lidarr; calls: () => number } {
    let calls = 0;
    const lidarr = {
      artist: {
        lookup: async (term: string) => {
          calls++;
          const mbid = entries[term];
          return mbid ? [{ artistName: term, foreignArtistId: mbid }] : [];
        },
      },
    } as unknown as Lidarr;
    return { lidarr, calls: () => calls };
  }

  /** Lidarr stub modelling the real `artist.lookup` semantics: the term is the
   *  query, the hit's `artistName` is what MusicBrainz (via Lidarr) returns
   *  and may differ. Used to exercise the issue #211 widening — the
   *  helper takes `query → hit` pairs so the lookup's hit can be a *superset*
   *  of the query (the canonical-name-drift case the widening fixes). */
  function makeLidarrLookup(
    entries: Record<string, { artistName: string; mbid: string; albumCount: number }>,
  ): { lidarr: Lidarr; calls: () => number } {
    let calls = 0;
    const lidarr = {
      artist: {
        lookup: async (term: string) => {
          calls++;
          const hit = entries[term];
          return hit
            ? [
                {
                  artistName: hit.artistName,
                  foreignArtistId: hit.mbid,
                  albumCount: hit.albumCount,
                },
              ]
            : [];
        },
      },
    } as unknown as Lidarr;
    return { lidarr, calls: () => calls };
  }

  function makeApp(
    role: 'admin' | 'user' | 'refiner',
    registry?: PluginRegistry,
    lidarr?: Lidarr,
  ): Hono<AuthEnv> {
    const app = new Hono<AuthEnv>();
    app.use('*', (c, next) => {
      c.set('user', { sub: 'u', role, iat: 0, exp: 9999999999 });
      return next();
    });
    app.route('/', libraryRoutes(undefined, { pluginRegistry: registry, lidarr }));
    return app;
  }

  it('GET /artists/:id includes bio/urls as null/empty with no library_artist_meta row', async () => {
    const artistId = seedArtistWithAlbum();
    const res = await makeApp('user').request(`/artists/${artistId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      artist: { bio: string | null; urls: string[]; metaExists: boolean; manualOverride: boolean };
    };
    expect(body.artist.bio).toBeNull();
    expect(body.artist.urls).toEqual([]);
    // No library_artist_meta row → the web uses this to fire a one-shot
    // auto-fetch on first visit (issue #213).
    expect(body.artist.metaExists).toBe(false);
    expect(body.artist.manualOverride).toBe(false);
  });

  it('GET /artists/:id flags a tombstoned (bio=null but row exists) row as metaExists=true', async () => {
    // A tombstone is `bio=NULL, urls=[]`, but the *row* is present — the web
    // must distinguish "never fetched" from "confident miss" so it doesn't
    // re-fire the auto-fetch on every visit.
    const artistId = seedArtistWithAlbum('art-tombstone', 'Tombstoned Artist');
    upsertMbid(testDb, {
      scope: 'artist',
      key: normalizeArtistForGrouping('Tombstoned Artist'),
      mbid: 'mbid-x',
      source: 'tag',
      confidence: 1,
    });
    const { registry } = makeRegistry({ result: null });
    await makeApp('refiner', registry).request(`/artists/${artistId}/refresh-info`, {
      method: 'POST',
    });
    const res = await makeApp('user').request(`/artists/${artistId}`);
    const body = (await res.json()) as {
      artist: { bio: string | null; metaExists: boolean; manualOverride: boolean };
    };
    expect(body.artist.bio).toBeNull();
    expect(body.artist.metaExists).toBe(true);
    expect(body.artist.manualOverride).toBe(false);
  });

  it('GET /artists/:id surfaces manualOverride=true so the web skips the auto-fetch', async () => {
    const artistId = seedArtistWithAlbum('art-override', 'Override Artist');
    upsertArtistMeta(testDb, {
      artistId,
      bio: 'Curator bio',
      urls: [],
      source: 'user',
      manualOverride: true,
    });
    const res = await makeApp('user').request(`/artists/${artistId}`);
    const body = (await res.json()) as {
      artist: { bio: string | null; metaExists: boolean; manualOverride: boolean };
    };
    expect(body.artist.bio).toBe('Curator bio');
    expect(body.artist.metaExists).toBe(true);
    expect(body.artist.manualOverride).toBe(true);
  });

  it('GET /artists/:id includes a stored bio', async () => {
    const artistId = seedArtistWithAlbum();
    upsertArtistMeta(testDb, {
      artistId,
      bio: 'A bio',
      urls: ['https://x.com'],
      source: 'discogs',
    });
    const res = await makeApp('user').request(`/artists/${artistId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artist: { bio: string | null; urls: string[] } };
    expect(body.artist.bio).toBe('A bio');
    expect(body.artist.urls).toEqual(['https://x.com']);
  });

  it('POST /artists/:id/refresh-info requires curator', async () => {
    const artistId = seedArtistWithAlbum();
    const res = await makeApp('user').request(`/artists/${artistId}/refresh-info`, {
      method: 'POST',
    });
    expect(res.status).toBe(403);
  });

  it('POST /artists/:id/refresh-info writes a tombstone when there is no known MBID', async () => {
    const artistId = seedArtistWithAlbum();
    const { registry, calls } = makeRegistry({ result: null });
    const res = await makeApp('refiner', registry).request(`/artists/${artistId}/refresh-info`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(getArtistMeta(testDb, artistId)?.bio).toBeNull();
    // No MBID is known for this artist, so the plugin is never even queried.
    expect(calls()).toBe(0);
  });

  it('POST /artists/:id/refresh-info resolves an MBID via Lidarr on a cache miss, then fetches the bio', async () => {
    // Production never populates library_mbids for artists automatically, so the
    // interactive refresh must resolve the id via Lidarr just like the background
    // task does (issue #207) — otherwise it always tombstones + returns null.
    const artistId = seedArtistWithAlbum('art-lidarr', 'Lidarr Artist');
    const { registry, calls: pluginCalls } = makeRegistry({
      result: {
        bio: 'Bio via Lidarr MBID',
        urls: ['https://example.org'],
        source: 'discogs',
        confidence: 0.9,
      },
    });
    const { lidarr, calls: lidarrCalls } = makeLidarr({ 'Lidarr Artist': 'mbid-lidarr' });
    const res = await makeApp('refiner', registry, lidarr).request(
      `/artists/${artistId}/refresh-info`,
      { method: 'POST' },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bio: string | null; urls: string[] };
    expect(body.bio).toBe('Bio via Lidarr MBID');
    expect(lidarrCalls()).toBe(1);
    expect(pluginCalls()).toBe(1);
    // The resolved MBID is persisted so future windows/refreshes hit the cache.
    expect(getMbid(testDb, 'artist', normalizeArtistForGrouping('Lidarr Artist'))?.mbid).toBe(
      'mbid-lidarr',
    );
    expect(getArtistMeta(testDb, artistId)?.bio).toBe('Bio via Lidarr MBID');
  });

  it('POST /artists/:id/refresh-info resolves via the issue #211 widening for canonical-name drift', async () => {
    // Real prod case (issue #211): library "Eduardo Miño" → Lidarr canonical
    // "Luis Eduardo Miño Naranjo" (contains the library name as a whole-token
    // subsequence, + `albumCount > 0` corroboration). The widened path reports
    // confidence 0.5 (vs 0.8 for exact) so `library_mbids` carries the
    // provenance forward.
    const artistId = seedArtistWithAlbum('art-drift', 'Eduardo Miño');
    const { registry, calls: pluginCalls } = makeRegistry({
      result: {
        bio: 'Bio via widened Lidarr MBID',
        urls: [],
        source: 'discogs',
        confidence: 0.9,
      },
    });
    const { lidarr, calls: lidarrCalls } = makeLidarrLookup({
      'Eduardo Miño': {
        artistName: 'Luis Eduardo Miño Naranjo',
        mbid: 'mbid-drift',
        albumCount: 12,
      },
    });
    const res = await makeApp('refiner', registry, lidarr).request(
      `/artists/${artistId}/refresh-info`,
      { method: 'POST' },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bio: string | null; urls: string[] };
    expect(body.bio).toBe('Bio via widened Lidarr MBID');
    expect(lidarrCalls()).toBe(1);
    expect(pluginCalls()).toBe(1);
    const mbidRow = getMbid(testDb, 'artist', normalizeArtistForGrouping('Eduardo Miño'));
    expect(mbidRow).toEqual(
      expect.objectContaining({ mbid: 'mbid-drift', source: 'lidarr', confidence: 0.5 }),
    );
  });

  it('POST /artists/:id/refresh-info does NOT widen when the Lidarr hit has albumCount=0', async () => {
    // The corroboration gate: a stub artist the same-name false-positive could
    // match never has zero albums, so `albumCount <= 0` is the safe rejection.
    const artistId = seedArtistWithAlbum('art-stub', 'Eduardo Miño');
    const { registry, calls: pluginCalls } = makeRegistry({
      // Returning a non-null bio would let the test pass spuriously; null is
      // the explicit "no bio found" surface so we can read the tombstone.
      result: null,
    });
    const { lidarr } = makeLidarrLookup({
      'Eduardo Miño': {
        artistName: 'Luis Eduardo Miño Naranjo',
        mbid: 'mbid-stub',
        albumCount: 0,
      },
    });
    const res = await makeApp('refiner', registry, lidarr).request(
      `/artists/${artistId}/refresh-info`,
      { method: 'POST' },
    );
    expect(res.status).toBe(200);
    // No MBID was resolvable, so no plugin call should have happened and the
    // route should tombstone.
    expect(pluginCalls()).toBe(0);
    expect(getMbid(testDb, 'artist', normalizeArtistForGrouping('Eduardo Miño'))).toBeNull();
    expect(getArtistMeta(testDb, artistId)?.bio).toBeNull();
  });

  it('POST /artists/:id/refresh-info fetches and stores bio/urls when an MBID is known', async () => {
    const artistId = seedArtistWithAlbum('art-mbid', 'MBID Artist');
    upsertMbid(testDb, {
      scope: 'artist',
      key: normalizeArtistForGrouping('MBID Artist'),
      mbid: 'mbid-1',
      source: 'tag',
      confidence: 1,
    });
    const { registry, calls } = makeRegistry({
      result: {
        bio: 'Fetched bio',
        urls: ['https://wiki.example'],
        source: 'discogs',
        confidence: 0.9,
      },
    });
    const res = await makeApp('refiner', registry).request(`/artists/${artistId}/refresh-info`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(calls()).toBe(1);
    const row = getArtistMeta(testDb, artistId);
    expect(row?.bio).toBe('Fetched bio');
    expect(row?.urls).toEqual(['https://wiki.example']);
    expect(row?.manualOverride).toBe(false);
  });

  it('POST /artists/:id/refresh-info returns 502 and writes no tombstone when the source throws', async () => {
    const artistId = seedArtistWithAlbum('art-mbid-2', 'Transient Fail Artist');
    upsertMbid(testDb, {
      scope: 'artist',
      key: normalizeArtistForGrouping('Transient Fail Artist'),
      mbid: 'mbid-2',
      source: 'tag',
      confidence: 1,
    });
    const { registry, calls } = makeRegistry({ throws: true });
    const res = await makeApp('refiner', registry).request(`/artists/${artistId}/refresh-info`, {
      method: 'POST',
    });
    expect(res.status).toBe(502);
    expect(calls()).toBe(1);
    // A transient failure is not a confident miss — no tombstone should be
    // written, so the artist stays retriable rather than looking permanently gone.
    expect(getArtistMeta(testDb, artistId)).toBeNull();
  });

  it('POST /artists/:id/refresh-info is rejected when the row is manually overridden', async () => {
    const artistId = seedArtistWithAlbum();
    upsertArtistMeta(testDb, {
      artistId,
      bio: 'Curator bio',
      urls: [],
      source: 'user',
      manualOverride: true,
    });
    const { registry, calls } = makeRegistry({ result: null });
    const res = await makeApp('refiner', registry).request(`/artists/${artistId}/refresh-info`, {
      method: 'POST',
    });
    expect(res.status).toBe(409);
    // Never even queries the plugin once a manual override is in place.
    expect(calls()).toBe(0);
    expect(getArtistMeta(testDb, artistId)?.bio).toBe('Curator bio');
  });

  it('PUT /artists/:id/info sets a manual override', async () => {
    const artistId = seedArtistWithAlbum();
    const res = await makeApp('refiner').request(`/artists/${artistId}/info`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bio: 'My bio', urls: ['https://x.com'] }),
    });
    expect(res.status).toBe(200);
    const row = getArtistMeta(testDb, artistId);
    expect(row?.bio).toBe('My bio');
    expect(row?.manualOverride).toBe(true);
    expect(row?.source).toBe('user');
  });

  it('PUT /artists/:id/info requires curator', async () => {
    const artistId = seedArtistWithAlbum();
    const res = await makeApp('user').request(`/artists/${artistId}/info`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bio: 'My bio', urls: [] }),
    });
    expect(res.status).toBe(403);
  });

  it('PUT /artists/:id/info always sets source=user/manualOverride even over a prior discogs row', async () => {
    const artistId = seedArtistWithAlbum();
    upsertArtistMeta(testDb, {
      artistId,
      bio: 'Old bio',
      urls: [],
      source: 'discogs',
      manualOverride: false,
    });
    const res = await makeApp('refiner').request(`/artists/${artistId}/info`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bio: 'Curator wins', urls: [] }),
    });
    expect(res.status).toBe(200);
    const row = getArtistMeta(testDb, artistId);
    expect(row?.bio).toBe('Curator wins');
    expect(row?.source).toBe('user');
    expect(row?.manualOverride).toBe(true);
  });

  // ─── Auto-fetch (issue #213) ─────────────────────────────────────────────
  // Silent one-shot Discogs fetch fired by the web on first artist-page visit
  // when `metaExists=false`. The route is auth-gated, NOT curator-gated, and
  // never surfaces a 409/502 — the client only fires it when no row exists,
  // so the post-fetch tombstone is the one-and-done guard the issue calls
  // out ("don't spam: a tombstone still means don't refetch every load").

  it('POST /artists/:id/auto-fetch-info fetches the bio and persists it for a non-curator user', async () => {
    // Critical: a plain `user` (not curator) must be able to fire this —
    // otherwise non-curator users would never see a bio until the background
    // task sweeps them, and the whole point of the auto-fetch is to fill
    // the gap on first page visit.
    const artistId = seedArtistWithAlbum('art-auto', 'Auto Artist');
    upsertMbid(testDb, {
      scope: 'artist',
      key: normalizeArtistForGrouping('Auto Artist'),
      mbid: 'mbid-auto',
      source: 'tag',
      confidence: 1,
    });
    const { registry, calls } = makeRegistry({
      result: {
        bio: 'Bio via auto-fetch',
        urls: ['https://wiki.example'],
        source: 'discogs',
        confidence: 0.9,
      },
    });
    const res = await makeApp('user', registry).request(`/artists/${artistId}/auto-fetch-info`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bio: string | null; urls: string[] };
    expect(body.bio).toBe('Bio via auto-fetch');
    expect(body.urls).toEqual(['https://wiki.example']);
    expect(calls()).toBe(1);
    expect(getArtistMeta(testDb, artistId)?.bio).toBe('Bio via auto-fetch');
  });

  it('POST /artists/:id/auto-fetch-info tombstones on a confident miss (no spam on next visit)', async () => {
    const artistId = seedArtistWithAlbum('art-auto-miss', 'Auto Miss Artist');
    upsertMbid(testDb, {
      scope: 'artist',
      key: normalizeArtistForGrouping('Auto Miss Artist'),
      mbid: 'mbid-miss',
      source: 'tag',
      confidence: 1,
    });
    const { registry, calls } = makeRegistry({ result: null });
    const res = await makeApp('user', registry).request(`/artists/${artistId}/auto-fetch-info`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bio: string | null; urls: string[] };
    expect(body.bio).toBeNull();
    expect(body.urls).toEqual([]);
    // Tombstone row is written so the next page load sees `metaExists=true`
    // and skips the auto-fetch.
    expect(getArtistMeta(testDb, artistId)?.bio).toBeNull();
    expect(getArtistMeta(testDb, artistId)?.source).toBe('discogs');
    expect(calls()).toBe(1);
  });

  it('POST /artists/:id/auto-fetch-info returns the existing bio and does not re-query on a manual_override row', async () => {
    const artistId = seedArtistWithAlbum('art-auto-override', 'Override Artist');
    upsertArtistMeta(testDb, {
      artistId,
      bio: 'Curator bio',
      urls: ['https://override.example'],
      source: 'user',
      manualOverride: true,
    });
    const { registry, calls } = makeRegistry({ result: null });
    const res = await makeApp('user', registry).request(`/artists/${artistId}/auto-fetch-info`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bio: string | null; urls: string[] };
    expect(body.bio).toBe('Curator bio');
    expect(body.urls).toEqual(['https://override.example']);
    // Never queries the plugin when a manual override is in place.
    expect(calls()).toBe(0);
    expect(getArtistMeta(testDb, artistId)?.bio).toBe('Curator bio');
  });

  it('POST /artists/:id/auto-fetch-info silently degrades on a provider throw (no 502, no toast)', async () => {
    // The explicit refresh path surfaces 502; the auto path must NOT, because
    // the trigger is the user opening the artist page (not a deliberate
    // request), and a transient provider blip should be invisible to them.
    const artistId = seedArtistWithAlbum('art-auto-throw', 'Auto Throw Artist');
    upsertMbid(testDb, {
      scope: 'artist',
      key: normalizeArtistForGrouping('Auto Throw Artist'),
      mbid: 'mbid-throw',
      source: 'tag',
      confidence: 1,
    });
    const { registry, calls } = makeRegistry({ throws: true });
    const res = await makeApp('user', registry).request(`/artists/${artistId}/auto-fetch-info`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bio: string | null; urls: string[] };
    expect(body.bio).toBeNull();
    expect(body.urls).toEqual([]);
    expect(calls()).toBe(1);
    // No tombstone was written (the source errored, not confidently missed) —
    // a future auto-fetch will retry the artist.
    expect(getArtistMeta(testDb, artistId)).toBeNull();
  });

  it('POST /artists/:id/auto-fetch-info tombstones when no MBID can be resolved', async () => {
    // Mirrors the explicit refresh route's behavior: with no Lidarr (or no
    // cached MBID) the artist can't be looked up, so a tombstone is written
    // and the client gets an empty result.
    const artistId = seedArtistWithAlbum('art-auto-no-mbid', 'No MBID Artist');
    const { registry, calls } = makeRegistry({ result: null });
    const res = await makeApp('user', registry).request(`/artists/${artistId}/auto-fetch-info`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(calls()).toBe(0);
    const row = getArtistMeta(testDb, artistId);
    expect(row?.bio).toBeNull();
    expect(row?.source).toBe('discogs');
  });
});

describe('artist origin routes', () => {
  const appFor = (role: 'listener' | 'user' | 'refiner' | 'admin') => {
    const a = new Hono<AuthEnv>();
    a.use('*', (c, next) => {
      c.set('user', { sub: 'u', role, iat: 0, exp: 9999999999 });
      return next();
    });
    a.route('/', libraryRoutes('/home/kevinch3/Music'));
    return a;
  };

  const seedOriginArtist = (id: string, name: string): void => {
    sharedDb.run(`DELETE FROM library_artists WHERE id = ?`, [id]);
    sharedDb.run(
      `INSERT INTO library_artists (id, name, album_count, synced_at) VALUES (?, ?, 1, 1)`,
      [id, name],
    );
  };

  beforeEach(() => {
    sharedDb.run(`DELETE FROM library_artist_origins`);
  });

  it('GET /artists/:id carries the origin', async () => {
    seedOriginArtist('art-og', 'Ana Tijoux');
    upsertArtistOrigin(sharedDb, { artistId: 'art-og', country: 'CL', source: 'musicbrainz' });
    const res = await appFor('user').request('/artists/art-og');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artist: { origin: unknown } };
    expect(body.artist.origin).toEqual({ country: 'CL', source: 'musicbrainz' });
  });

  it('GET /artists/:id reports a missing origin as null', async () => {
    seedOriginArtist('art-og2', 'No Origin Yet');
    const res = await appFor('user').request('/artists/art-og2');
    const body = (await res.json()) as { artist: { origin: unknown } };
    expect(body.artist.origin).toBe(null);
  });

  it('PUT /artists/:id/origin writes a permanent user row; null = user tombstone', async () => {
    seedOriginArtist('art-og3', 'Correctable');
    const res = await appFor('refiner').request('/artists/art-og3/origin', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ country: 'ar' }),
    });
    expect(res.status).toBe(200);
    expect(getArtistOrigin(sharedDb, 'art-og3')).toMatchObject({ country: 'AR', source: 'user' });

    const cleared = await appFor('refiner').request('/artists/art-og3/origin', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ country: null }),
    });
    expect(cleared.status).toBe(200);
    expect(getArtistOrigin(sharedDb, 'art-og3')).toMatchObject({ country: null, source: 'user' });
  });

  it('PUT rejects a non-ISO code with 400 and gates on curator', async () => {
    seedOriginArtist('art-og4', 'Gated');
    const bad = await appFor('refiner').request('/artists/art-og4/origin', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ country: 'Argentina' }),
    });
    expect(bad.status).toBe(400);

    const forbidden = await appFor('user').request('/artists/art-og4/origin', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ country: 'AR' }),
    });
    expect(forbidden.status).toBe(403);
    expect(getArtistOrigin(sharedDb, 'art-og4')).toBe(null);
  });

  it('PUT 404s an unknown artist', async () => {
    const res = await appFor('refiner').request('/artists/no-such-artist/origin', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ country: 'AR' }),
    });
    expect(res.status).toBe(404);
  });

  it('GET /origin-countries returns the facets', async () => {
    seedOriginArtist('art-og5', 'Facet Artist');
    upsertArtistOrigin(sharedDb, { artistId: 'art-og5', country: 'CL', source: 'user' });
    const res = await appFor('user').request('/origin-countries');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      countries: Array<{ country: string; artists: number }>;
      unknownArtists: number;
    };
    expect(body.countries.find((c) => c.country === 'CL')?.artists).toBe(1);
  });
});

/**
 * Issue #610 part C. `MbidSource` has always declared a `'user'` tier ranked
 * above `tag`, but nothing ever wrote it — so a curator could repaint the
 * symptoms (bio, origin) while the wrong id stayed cached and kept feeding
 * every other MBID-derived enrichment. This is the repair path.
 */
describe('curator artist MBID override (issue #610)', () => {
  const MERNES = '0d5a1ad3-eaac-4aed-9ca2-96293cf6a2f4';
  const SWEDISH_MC = '1c4f6d71-ab3f-45ef-841f-d69022f6ef0d';

  const appFor = (role: 'listener' | 'user' | 'refiner' | 'admin') => {
    const a = new Hono<AuthEnv>();
    a.use('*', (c, next) => {
      c.set('user', { sub: 'u', role, iat: 0, exp: 9999999999 });
      return next();
    });
    a.route('/', libraryRoutes('/home/kevinch3/Music'));
    return a;
  };

  /** Seeds the exact prod shape: right artist, wrong id, wrong derived rows. */
  const seedPoisoned = (id: string, name: string): void => {
    sharedDb.run(`DELETE FROM library_artists WHERE id = ?`, [id]);
    sharedDb.run(
      `INSERT INTO library_artists (id, name, album_count, synced_at) VALUES (?, ?, 3, 1)`,
      [id, name],
    );
    upsertMbid(sharedDb, {
      scope: 'artist',
      key: normalizeArtistForGrouping(name),
      mbid: SWEDISH_MC,
      source: 'lidarr',
      confidence: 0.8,
    });
    upsertArtistMeta(sharedDb, {
      artistId: id,
      bio: 'Swedish singer and songwriter.',
      urls: [],
      source: 'discogs',
    });
    upsertArtistOrigin(sharedDb, { artistId: id, country: 'SE', source: 'musicbrainz' });
  };

  const put = (id: string, body: unknown, role: 'user' | 'refiner' = 'refiner') =>
    appFor(role).request(`/artists/${id}/mbid`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('writes a user-sourced id that outranks the wrong lidarr one', async () => {
    seedPoisoned('art-mb1', 'Emilia');
    const res = await put('art-mb1', { mbid: MERNES });
    expect(res.status).toBe(200);
    const row = getMbid(sharedDb, 'artist', normalizeArtistForGrouping('Emilia'));
    expect(row).toMatchObject({ mbid: MERNES, source: 'user' });
  });

  it('clears the bio and origin the wrong id produced, so they re-derive', async () => {
    seedPoisoned('art-mb2', 'Emilia Two');
    await put('art-mb2', { mbid: MERNES });
    expect(getArtistMeta(sharedDb, 'art-mb2')).toBeNull();
    expect(getArtistOrigin(sharedDb, 'art-mb2')).toBeNull();
  });

  it("never discards a curator's own hand-written bio", async () => {
    seedPoisoned('art-mb3', 'Emilia Three');
    upsertArtistMeta(sharedDb, {
      artistId: 'art-mb3',
      bio: 'Hand-written by a curator.',
      urls: [],
      source: 'user',
      manualOverride: true,
    });
    await put('art-mb3', { mbid: MERNES });
    expect(getArtistMeta(sharedDb, 'art-mb3')?.bio).toBe('Hand-written by a curator.');
  });

  it('clears the override on null, reopening the artist to resolution', async () => {
    seedPoisoned('art-mb4', 'Emilia Four');
    await put('art-mb4', { mbid: MERNES });
    const res = await put('art-mb4', { mbid: null });
    expect(res.status).toBe(200);
    expect(getMbid(sharedDb, 'artist', normalizeArtistForGrouping('Emilia Four'))).toBeNull();
  });

  it('rejects a malformed id with 400', async () => {
    seedPoisoned('art-mb5', 'Emilia Five');
    expect((await put('art-mb5', { mbid: 'not-a-uuid' })).status).toBe(400);
    expect((await put('art-mb5', {})).status).toBe(400);
  });

  it('gates on curator and 404s an unknown artist', async () => {
    seedPoisoned('art-mb6', 'Emilia Six');
    expect((await put('art-mb6', { mbid: MERNES }, 'user')).status).toBe(403);
    expect((await put('no-such-artist', { mbid: MERNES })).status).toBe(404);
  });
});
