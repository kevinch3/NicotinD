import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { libraryRoutes } from './library.js';

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

    app = new Hono();
    app.route('/', libraryRoutes(navidromeMock, '/home/kevinch3/Music'));
  });

  it('deletes a song using an absolute path from Navidrome', async () => {
    fsState.set('/home/kevinch3/Music/Artist/Album/song.mp3', true);

    const res = await app.request('/songs/song-1', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(fsState.has('/home/kevinch3/Music/Artist/Album/song.mp3')).toBe(false);
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
});
