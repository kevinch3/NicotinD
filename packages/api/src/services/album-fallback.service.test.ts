import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { AlbumFallbackService, type AlternateCandidate } from './album-fallback.service.js';
import type { Slskd } from '@nicotind/slskd-client';

interface MockFile {
  id: string;
  filename: string;
  size: number;
  state: string;
}

function makeSlskd(groups: Array<{ username: string; directory: string; files: MockFile[] }>) {
  const enqueue = mock(async (_u: string, _files: Array<{ filename: string; size: number }>) => undefined);
  const getDownloads = mock(async () =>
    groups.map((g) => ({
      username: g.username,
      directories: [{ directory: g.directory, fileCount: g.files.length, files: g.files }],
    })),
  );
  const slskd = { transfers: { getDownloads, enqueue } } as unknown as Slskd;
  return { slskd, enqueue };
}

function makeDb(): Database {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
}

function recordJob(db: Database, alternates: AlternateCandidate[]) {
  AlbumFallbackService.recordJob(db, {
    lidarrAlbumId: 1,
    username: 'primary',
    directory: 'Album',
    canonicalTracks: ['Song One', 'Song Two', 'Song Three'],
    alternates,
  });
}

function jobState(db: Database): string {
  return (db.query('SELECT state FROM album_jobs WHERE id = 1').get() as { state: string }).state;
}

const ALT: AlternateCandidate = {
  username: 'alt',
  directory: 'AltAlbum',
  files: [
    { filename: 'AltAlbum/01 Song One.flac', size: 1 },
    { filename: 'AltAlbum/02 Song Two.flac', size: 1 },
    { filename: 'AltAlbum/03 Song Three.flac', size: 1 },
  ],
};

describe('AlbumFallbackService', () => {
  let db: Database;
  beforeEach(() => {
    db = makeDb();
  });

  it('pulls only the missing tracks from an alternate once the primary gives up', async () => {
    // Primary delivered track one, gave up on two and three.
    const { slskd, enqueue } = makeSlskd([
      {
        username: 'primary',
        directory: 'Album',
        files: [
          { id: 'p1', filename: 'Album/01 Song One.flac', size: 1, state: 'Completed, Succeeded' },
          { id: 'p2', filename: 'Album/02 Song Two.flac', size: 1, state: 'Completed, Errored' },
          { id: 'p3', filename: 'Album/03 Song Three.flac', size: 1, state: 'Completed, Errored' },
        ],
      },
    ]);
    db.run(
      `INSERT INTO transfer_retries (transfer_key, username, filename, attempts, gave_up) VALUES
       ('primary::Album/02 Song Two.flac', 'primary', 'x', 3, 1),
       ('primary::Album/03 Song Three.flac', 'primary', 'x', 3, 1)`,
    );
    recordJob(db, [ALT]);

    const svc = new AlbumFallbackService(slskd, { db });
    await svc.sweep();

    expect(enqueue).toHaveBeenCalledTimes(1);
    const [user, files] = enqueue.mock.calls[0];
    expect(user).toBe('alt');
    expect((files as Array<{ filename: string }>).map((f) => f.filename)).toEqual([
      'AltAlbum/02 Song Two.flac',
      'AltAlbum/03 Song Three.flac',
    ]);
  });

  it('does not act while the primary is still working', async () => {
    const { slskd, enqueue } = makeSlskd([
      {
        username: 'primary',
        directory: 'Album',
        files: [
          { id: 'p1', filename: 'Album/01 Song One.flac', size: 1, state: 'Completed, Succeeded' },
          { id: 'p2', filename: 'Album/02 Song Two.flac', size: 1, state: 'InProgress' },
          { id: 'p3', filename: 'Album/03 Song Three.flac', size: 1, state: 'Completed, Errored' },
        ],
      },
    ]);
    recordJob(db, [ALT]);

    const svc = new AlbumFallbackService(slskd, { db });
    await svc.sweep();

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('marks the job done when every track is satisfied across peers', async () => {
    const { slskd, enqueue } = makeSlskd([
      {
        username: 'primary',
        directory: 'Album',
        files: [
          { id: 'p1', filename: 'Album/01 Song One.flac', size: 1, state: 'Completed, Succeeded' },
        ],
      },
      {
        username: 'alt',
        directory: 'AltAlbum',
        files: [
          { id: 'a2', filename: 'AltAlbum/02 Song Two.flac', size: 1, state: 'Completed, Succeeded' },
          { id: 'a3', filename: 'AltAlbum/03 Song Three.flac', size: 1, state: 'Completed, Succeeded' },
        ],
      },
    ]);
    recordJob(db, [ALT]);

    const svc = new AlbumFallbackService(slskd, { db });
    await svc.sweep();

    expect(enqueue).not.toHaveBeenCalled();
    expect(jobState(db)).toBe('done');
  });

  it('marks the job exhausted when no alternate covers the missing tracks', async () => {
    const { slskd, enqueue } = makeSlskd([
      {
        username: 'primary',
        directory: 'Album',
        files: [
          { id: 'p1', filename: 'Album/01 Song One.flac', size: 1, state: 'Completed, Succeeded' },
          { id: 'p2', filename: 'Album/02 Song Two.flac', size: 1, state: 'Completed, Errored' },
        ],
      },
    ]);
    db.run(
      `INSERT INTO transfer_retries (transfer_key, username, filename, attempts, gave_up)
       VALUES ('primary::Album/02 Song Two.flac', 'primary', 'x', 3, 1)`,
    );
    // Alternate has nothing matching the missing "Song Two" / "Song Three".
    recordJob(db, [
      { username: 'alt', directory: 'X', files: [{ filename: 'X/unrelated.flac', size: 1 }] },
    ]);

    const svc = new AlbumFallbackService(slskd, { db });
    await svc.sweep();

    expect(enqueue).not.toHaveBeenCalled();
    expect(jobState(db)).toBe('exhausted');
  });
});
