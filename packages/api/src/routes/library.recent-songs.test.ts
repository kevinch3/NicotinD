import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { libraryRoutes } from './library.js';
import { getDatabase, initDatabase } from '../db.js';

describe('library recent-songs ordering', () => {
  let app: Hono<any>;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'nicotind-library-recent-'));
    initDatabase(dataDir);

    const navidromeMock = {
      browsing: {
        getAlbumList: mock(() =>
          Promise.resolve([
            { id: 'album-1', name: 'Alpha', artist: 'Artist A' },
            { id: 'album-2', name: 'Beta', artist: 'Artist B' },
          ]),
        ),
        getAlbum: mock((albumId: string) => {
          if (albumId === 'album-1') {
            return Promise.resolve({
              songs: [
                {
                  id: 'song-1',
                  title: 'First',
                  artist: 'Artist A',
                  album: 'Alpha',
                  path: 'Artist A/Alpha/01 - First.mp3',
                  created: '2026-03-20T10:00:00.000Z',
                },
                {
                  id: 'song-2',
                  title: 'Second',
                  artist: 'Artist A',
                  album: 'Alpha',
                  path: 'Artist A/Alpha/02 - Second.mp3',
                  created: '2026-03-20T09:00:00.000Z',
                },
              ],
            });
          }

          return Promise.resolve({
            songs: [
              {
                id: 'song-3',
                title: 'Third',
                artist: 'Artist B',
                album: 'Beta',
                path: 'Artist B/Beta/01 - Third.mp3',
                created: '2026-03-20T08:00:00.000Z',
              },
            ],
          });
        }),
      },
    };

    app = new Hono();
    app.route('/', libraryRoutes(navidromeMock as any, '/music'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('orders songs by completion timestamp when history exists', async () => {
    const db = getDatabase();
    db.run(
      `INSERT INTO completed_downloads
       (transfer_key, username, directory, filename, relative_path, basename, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        'user-1:transfer-1',
        'user-1',
        'Artist A/Alpha',
        'Artist A/Alpha/01 - First.mp3',
        'Artist A/Alpha/01 - First.mp3',
        '01 - first.mp3',
        1000,
      ],
    );
    db.run(
      `INSERT INTO completed_downloads
       (transfer_key, username, directory, filename, relative_path, basename, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        'user-1:transfer-2',
        'user-1',
        'Artist A/Alpha',
        'Artist A/Alpha/02 - Second.mp3',
        'Artist A/Alpha/02 - Second.mp3',
        '02 - second.mp3',
        3000,
      ],
    );
    db.run(
      `INSERT INTO completed_downloads
       (transfer_key, username, directory, filename, relative_path, basename, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        'user-1:transfer-3',
        'user-1',
        'Artist B/Beta',
        'Artist B/Beta/01 - Third.mp3',
        'Artist B/Beta/01 - Third.mp3',
        '01 - third.mp3',
        2000,
      ],
    );

    const res = await app.request('/recent-songs?size=10');
    expect(res.status).toBe(200);

    const data = await res.json() as Array<{ id: string }>;
    expect(data.map((s) => s.id)).toEqual(['song-2', 'song-3', 'song-1']);
  });

  it('falls back to created-time ordering when history is unavailable', async () => {
    const db = getDatabase();
    db.run('DELETE FROM completed_downloads');

    const res = await app.request('/recent-songs?size=10');
    expect(res.status).toBe(200);

    const data = await res.json() as Array<{ id: string }>;
    expect(data.map((s) => s.id)).toEqual(['song-1', 'song-2', 'song-3']);
  });
});
