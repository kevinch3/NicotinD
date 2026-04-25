import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { libraryRoutes } from './library.js';

mock.module('../db.js', () => ({
  getDatabase: () => {
    const db = new Database(':memory:');
    db.run(`
      CREATE TABLE IF NOT EXISTS completed_downloads (
        transfer_key TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        directory TEXT NOT NULL,
        filename TEXT NOT NULL,
        relative_path TEXT,
        basename TEXT NOT NULL,
        completed_at INTEGER NOT NULL
      )
    `);
    return db;
  },
}));

const fsState = new Map<string, boolean>();
const dirEntries = new Map<string, Array<{ name: string; isFile: boolean; isDirectory: boolean }>>();

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
}));

describe('library routes', () => {
  let navidromeMock: any;
  let app: Hono<any>;

  beforeEach(() => {
    fsState.clear();
    dirEntries.clear();

    navidromeMock = {
      browsing: {
        getSong: mock(() =>
          Promise.resolve({
            id: 'song-1',
            path: '/home/kevinch3/Music/Artist/Album/song.mp3',
          }),
        ),
      },
      system: {
        startScan: mock(() => Promise.resolve()),
      },
    };

    app = new Hono<any>();
    app.use('*', (c, next) => {
      c.set('user', { sub: 'test-user', role: 'admin', iat: 0, exp: 9999999999 });
      return next();
    });
    app.route('/', libraryRoutes(navidromeMock, '/home/kevinch3/Music'));
  });

  it('deletes a song using an absolute path from Navidrome', async () => {
    fsState.set('/home/kevinch3/Music/Artist/Album/song.mp3', true);

    const res = await app.request('/songs/song-1', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(fsState.has('/home/kevinch3/Music/Artist/Album/song.mp3')).toBe(false);
    expect(navidromeMock.system.startScan).toHaveBeenCalledWith(true);
  });

  it('bulk deletes multiple songs and triggers a single scan', async () => {
    navidromeMock.browsing.getSong = mock((id: string) => {
      const paths: Record<string, string> = {
        's1': '/home/kevinch3/Music/A/a.mp3',
        's2': '/home/kevinch3/Music/B/b.mp3'
      };
      return Promise.resolve({ id, path: paths[id] });
    });
    fsState.set('/home/kevinch3/Music/A/a.mp3', true);
    fsState.set('/home/kevinch3/Music/B/b.mp3', true);

    const res = await app.request('/songs/bulk-delete', {
      method: 'POST',
      body: JSON.stringify({ ids: ['s1', 's2'] })
    });

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.deletedCount).toBe(2);
    expect(fsState.has('/home/kevinch3/Music/A/a.mp3')).toBe(false);
    expect(fsState.has('/home/kevinch3/Music/B/b.mp3')).toBe(false);
    expect(navidromeMock.system.startScan).toHaveBeenCalledTimes(1);
    expect(navidromeMock.system.startScan).toHaveBeenCalledWith(true);
  });

  it('resolves a renamed file in the same directory', async () => {
    navidromeMock.browsing.getSong = mock(() =>
      Promise.resolve({
        id: 'song-2',
        path: '/home/kevinch3/Music/Artist/Album/song.mp3',
      }),
    );
    fsState.set('/home/kevinch3/Music/Artist/Album/song.mp3', false);
    fsState.set('/home/kevinch3/Music/Artist/Album/song_123.mp3', true);
    fsState.set('/home/kevinch3/Music/Artist/Album', true);
    dirEntries.set('/home/kevinch3/Music/Artist/Album', [
      { name: 'song_123.mp3', isFile: true, isDirectory: false },
    ]);

    const res = await app.request('/songs/song-2', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(fsState.has('/home/kevinch3/Music/Artist/Album/song_123.mp3')).toBe(false);
    expect(navidromeMock.system.startScan).toHaveBeenCalledWith(true);
  });

  it('finds the real file when the library path is stale and the folder name changed', async () => {
    navidromeMock.browsing.getSong = mock(() =>
      Promise.resolve({
        id: 'song-3',
        path: '/home/kevinch3/Music/Bryn Terfel/We\'ll Keep A Welcome/06 - Calon Lân.mp3',
        title: 'Calon Lân',
        artist: 'Bryn Terfel',
        album: 'We\'ll Keep A Welcome',
        track: 6,
      }),
    );

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
    expect(fsState.has('/home/kevinch3/Music/Bryn Terfel - Keep A Welcome/06. Calon Lân.mp3')).toBe(false);
    expect(navidromeMock.system.startScan).toHaveBeenCalledWith(true);
  });

  it('finds a file by filename tokens when tags are missing', async () => {
    navidromeMock.browsing.getSong = mock(() =>
      Promise.resolve({
        id: 'song-4',
        path: '/home/kevinch3/Music/[Unknown Artist]/[Unknown Album]/13 - 14_CALON_LAN_639096876154326491.mp3',
      }),
    );

    fsState.set('/home/kevinch3/Music', true);
    fsState.set('/home/kevinch3/Music/CD2', true);
    fsState.set('/home/kevinch3/Music/CD2/14_CALON_LAN.MP3', true);
    dirEntries.set('/home/kevinch3/Music', [
      { name: 'CD2', isFile: false, isDirectory: true },
    ]);
    dirEntries.set('/home/kevinch3/Music/CD2', [
      { name: '14_CALON_LAN.MP3', isFile: true, isDirectory: false },
    ]);

    const res = await app.request('/songs/song-4', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(fsState.has('/home/kevinch3/Music/CD2/14_CALON_LAN.MP3')).toBe(false);
    expect(navidromeMock.system.startScan).toHaveBeenCalledWith(true);
  });

  it('returns 404 when no matching file exists and does not rescan', async () => {
    navidromeMock.browsing.getSong = mock(() =>
      Promise.resolve({
        id: 'song-5',
        path: '/home/kevinch3/Music/Missing/Nope.mp3',
        title: 'Nope',
        artist: 'Missing Artist',
        album: 'Missing Album',
      }),
    );

    const res = await app.request('/songs/song-5', { method: 'DELETE' });

    expect(res.status).toBe(404);
    expect(navidromeMock.system.startScan).not.toHaveBeenCalled();
  });
});
