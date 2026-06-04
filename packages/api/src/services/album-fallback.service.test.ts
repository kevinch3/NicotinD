import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { AlbumFallbackService, type AlternateCandidate } from './album-fallback.service.js';
import { albumIdFor } from './library-scanner.js';
import type { Slskd } from '@nicotind/slskd-client';

interface MockFile {
  id: string;
  filename: string;
  size: number;
  state: string;
}

function makeSlskd(groups: Array<{ username: string; directory: string; files: MockFile[] }>) {
  const enqueue = mock(
    async (_u: string, _files: Array<{ filename: string; size: number }>) => undefined,
  );
  const getDownloads = mock(async () =>
    groups.map((g) => ({
      username: g.username,
      directories: [{ directory: g.directory, fileCount: g.files.length, files: g.files }],
    })),
  );
  const slskd = { transfers: { getDownloads, enqueue } } as unknown as Slskd;
  return { slskd, enqueue };
}

interface SearchResponse {
  username: string;
  freeUploadSlots?: number;
  queueLength?: number;
  uploadSpeed?: number;
  files: Array<{ filename: string; size: number; bitRate?: number }>;
}

/** Extends the transfers mock with a slskd search stub for fresh-search tests. */
function makeSlskdWithSearch(
  groups: Array<{ username: string; directory: string; files: MockFile[] }>,
  searchResponses: SearchResponse[],
) {
  const { slskd, enqueue } = makeSlskd(groups);
  const create = mock(async (_q: string) => ({ id: 's1', state: 'Completed' }));
  const get = mock(async () => ({ state: 'Completed' }));
  const getResponses = mock(async () => searchResponses);
  const del = mock(async () => undefined);
  (slskd as unknown as { searches: unknown }).searches = {
    create,
    get,
    getResponses,
    delete: del,
  };
  return { slskd, enqueue, create };
}

function makeDb(): Database {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
}

function attempts(db: Database): number {
  return (
    db.query('SELECT fallback_attempts AS a FROM album_jobs WHERE id = 1').get() as { a: number }
  ).a;
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
          {
            id: 'a2',
            filename: 'AltAlbum/02 Song Two.flac',
            size: 1,
            state: 'Completed, Succeeded',
          },
          {
            id: 'a3',
            filename: 'AltAlbum/03 Song Three.flac',
            size: 1,
            state: 'Completed, Succeeded',
          },
        ],
      },
    ]);
    recordJob(db, [ALT]);

    const svc = new AlbumFallbackService(slskd, { db });
    await svc.sweep();

    expect(enqueue).not.toHaveBeenCalled();
    expect(jobState(db)).toBe('done');
  });

  it('does not chase deluxe canonical tracks once the chosen folder downloaded in full', async () => {
    // Regression: the chosen folder delivered all of its own files, but the
    // canonical Lidarr tracklist is a bloated deluxe edition with extra cuts no
    // single folder has. Targeting the manifest (not the canonical list) must
    // mark the job done so the fallback never dumps duplicate rips into it.
    const { slskd, enqueue } = makeSlskd([
      {
        username: 'primary',
        directory: 'Album',
        files: [
          { id: 'p1', filename: 'Album/01 Song One.flac', size: 1, state: 'Completed, Succeeded' },
          { id: 'p2', filename: 'Album/02 Song Two.flac', size: 1, state: 'Completed, Succeeded' },
        ],
      },
    ]);
    AlbumFallbackService.recordJob(db, {
      lidarrAlbumId: 1,
      username: 'primary',
      directory: 'Album',
      // Deluxe canonical list — far larger than the chosen folder.
      canonicalTracks: [
        'Song One',
        'Song Two',
        'Bonus Live One',
        'Bonus Acoustic Two',
        'Demo Three',
      ],
      targetFiles: [{ filename: 'Album/01 Song One.flac' }, { filename: 'Album/02 Song Two.flac' }],
      alternates: [ALT],
    });

    const svc = new AlbumFallbackService(slskd, { db });
    await svc.sweep();

    expect(enqueue).not.toHaveBeenCalled();
    expect(jobState(db)).toBe('done');
  });

  it('recovers a manifest track the primary failed, from an alternate', async () => {
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
    AlbumFallbackService.recordJob(db, {
      lidarrAlbumId: 1,
      username: 'primary',
      directory: 'Album',
      canonicalTracks: ['Song One', 'Song Two', 'Song Three'],
      targetFiles: [{ filename: 'Album/01 Song One.flac' }, { filename: 'Album/02 Song Two.flac' }],
      alternates: [ALT],
    });

    const svc = new AlbumFallbackService(slskd, { db });
    await svc.sweep();

    expect(enqueue).toHaveBeenCalledTimes(1);
    const [user, files] = enqueue.mock.calls[0];
    expect(user).toBe('alt');
    // Only the failed manifest track is pulled — not Song Three (not in the
    // chosen folder) nor Song One (already delivered).
    expect((files as Array<{ filename: string }>).map((f) => f.filename)).toEqual([
      'AltAlbum/02 Song Two.flac',
    ]);
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

  it('recovers a missing track via a fresh per-track search when no alternate covers it', async () => {
    const { slskd, enqueue, create } = makeSlskdWithSearch(
      [
        {
          username: 'primary',
          directory: 'Album',
          files: [
            {
              id: 'p1',
              filename: 'Album/01 Song One.flac',
              size: 1,
              state: 'Completed, Succeeded',
            },
            { id: 'p2', filename: 'Album/02 Song Two.flac', size: 1, state: 'Completed, Errored' },
          ],
        },
      ],
      // A fresh search turns up a peer that has the failed track.
      [
        {
          username: 'freshpeer',
          freeUploadSlots: 1,
          queueLength: 0,
          uploadSpeed: 1000,
          files: [{ filename: 'Random/02 Song Two.flac', size: 1 }],
        },
      ],
    );
    db.run(
      `INSERT INTO transfer_retries (transfer_key, username, filename, attempts, gave_up)
       VALUES ('primary::Album/02 Song Two.flac', 'primary', 'x', 3, 1)`,
    );
    AlbumFallbackService.recordJob(db, {
      lidarrAlbumId: 1,
      username: 'primary',
      directory: 'Album',
      artistName: 'Artist',
      canonicalTracks: ['Song One', 'Song Two'],
      targetFiles: [{ filename: 'Album/01 Song One.flac' }, { filename: 'Album/02 Song Two.flac' }],
      // No recorded alternate can supply the gap — forces the fresh search.
      alternates: [],
    });

    const svc = new AlbumFallbackService(slskd, { db });
    await svc.sweep();

    // Query uses the normalized (folded/lowercased) track title.
    expect(create).toHaveBeenCalledWith('Artist song two');
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [user, files] = enqueue.mock.calls[0];
    expect(user).toBe('freshpeer');
    expect((files as Array<{ filename: string }>).map((f) => f.filename)).toEqual([
      'Random/02 Song Two.flac',
    ]);
    // Wave counted; job stays active until the download lands.
    expect(attempts(db)).toBe(1);
    expect(jobState(db)).toBe('active');
  });

  it('fresh search prefers the clean studio track over a (5.1 mix) from a healthier peer', async () => {
    const { slskd, enqueue } = makeSlskdWithSearch(
      [
        {
          username: 'primary',
          directory: 'Album',
          files: [
            {
              id: 'p1',
              filename: 'Album/01 Song One.flac',
              size: 1,
              state: 'Completed, Succeeded',
            },
            { id: 'p2', filename: 'Album/02 Song Two.flac', size: 1, state: 'Completed, Errored' },
          ],
        },
      ],
      [
        // Healthiest peer only has the 5.1 mix — must NOT win.
        {
          username: 'mixpeer',
          freeUploadSlots: 1,
          queueLength: 0,
          uploadSpeed: 9_000_000,
          files: [{ filename: 'Deluxe/02 Song Two (5.1 mix).flac', size: 5 }],
        },
        // Less healthy peer has the clean studio track — should win on cleanliness.
        {
          username: 'cleanpeer',
          freeUploadSlots: 0,
          queueLength: 50,
          uploadSpeed: 1000,
          files: [{ filename: 'Studio/02 Song Two.flac', size: 1 }],
        },
      ],
    );
    db.run(
      `INSERT INTO transfer_retries (transfer_key, username, filename, attempts, gave_up)
       VALUES ('primary::Album/02 Song Two.flac', 'primary', 'x', 3, 1)`,
    );
    AlbumFallbackService.recordJob(db, {
      lidarrAlbumId: 1,
      username: 'primary',
      directory: 'Album',
      artistName: 'Artist',
      canonicalTracks: ['Song One', 'Song Two'],
      targetFiles: [{ filename: 'Album/01 Song One.flac' }, { filename: 'Album/02 Song Two.flac' }],
      alternates: [],
    });

    await new AlbumFallbackService(slskd, { db }).sweep();

    expect(enqueue).toHaveBeenCalledTimes(1);
    const [user, files] = enqueue.mock.calls[0];
    expect(user).toBe('cleanpeer');
    expect((files as Array<{ filename: string }>).map((f) => f.filename)).toEqual([
      'Studio/02 Song Two.flac',
    ]);
  });

  it('exhausts once fresh searches keep finding nothing and the attempt cap is hit', async () => {
    const { slskd, enqueue, create } = makeSlskdWithSearch(
      [
        {
          username: 'primary',
          directory: 'Album',
          files: [
            {
              id: 'p1',
              filename: 'Album/01 Song One.flac',
              size: 1,
              state: 'Completed, Succeeded',
            },
            { id: 'p2', filename: 'Album/02 Song Two.flac', size: 1, state: 'Completed, Errored' },
          ],
        },
      ],
      [], // fresh search finds nothing
    );
    db.run(
      `INSERT INTO transfer_retries (transfer_key, username, filename, attempts, gave_up)
       VALUES ('primary::Album/02 Song Two.flac', 'primary', 'x', 3, 1)`,
    );
    AlbumFallbackService.recordJob(db, {
      lidarrAlbumId: 1,
      username: 'primary',
      directory: 'Album',
      artistName: 'Artist',
      canonicalTracks: ['Song One', 'Song Two'],
      targetFiles: [{ filename: 'Album/01 Song One.flac' }, { filename: 'Album/02 Song Two.flac' }],
      alternates: [],
    });

    const svc = new AlbumFallbackService(slskd, { db, maxFallbackAttempts: 1 });
    await svc.sweep(); // wave 1: searches, finds nothing, attempts -> 1
    expect(create).toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(jobState(db)).toBe('active');

    await svc.sweep(); // attempts (1) >= cap (1) -> exhausted
    expect(jobState(db)).toBe('exhausted');
  });

  // ── Auto-retry of exhausted jobs (revive + disk-aware sweep) ──────────────

  interface ExhaustedOpts {
    artist?: string | null;
    album?: string;
    targets?: string[];
    reviveCount?: number;
    lastRevivedAt?: number | null;
  }

  function insertExhausted(database: Database, opts: ExhaustedOpts = {}): void {
    database.run(
      `INSERT INTO album_jobs
        (id, lidarr_album_id, username, directory, artist_name, album_title,
         canonical_tracks_json, target_files_json, alternates_json,
         fallback_attempts, state, created_at, revive_count, last_revived_at)
       VALUES (1, 1, 'primary', 'Album', ?, ?, ?, ?, '[]', 0, 'exhausted', 0, ?, ?)`,
      [
        opts.artist === undefined ? 'Artist' : opts.artist,
        opts.album ?? 'Album',
        JSON.stringify(opts.targets ?? ['Album/01 Song One.flac', 'Album/02 Song Two.flac']),
        JSON.stringify(opts.targets ?? ['Album/01 Song One.flac', 'Album/02 Song Two.flac']),
        opts.reviveCount ?? 0,
        opts.lastRevivedAt ?? null,
      ],
    );
  }

  function seedSong(database: Database, artist: string, album: string, title: string): void {
    const albumId = albumIdFor(artist, album);
    database.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, path, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
      [`${albumId}-${title}`, albumId, title, artist, 'aid', `/m/${title}.flac`],
    );
  }

  it('revives an eligible exhausted job and marks it done when the album is fully on disk', async () => {
    // Original transfers are long gone from slskd (getDownloads empty); the
    // disk-aware sweep must see both tracks already in the library → done, with
    // no re-download.
    const { slskd, enqueue } = makeSlskd([]);
    insertExhausted(db);
    seedSong(db, 'Artist', 'Album', 'Song One');
    seedSong(db, 'Artist', 'Album', 'Song Two');

    const svc = new AlbumFallbackService(slskd, { db, autoRetryExhausted: true });
    await svc.sweep();

    expect(enqueue).not.toHaveBeenCalled();
    expect(jobState(db)).toBe('done');
    const row = db.query('SELECT revive_count AS r FROM album_jobs WHERE id = 1').get() as {
      r: number;
    };
    expect(row.r).toBe(1);
  });

  it('revives an exhausted job and fresh-searches only the track still missing from disk', async () => {
    const { slskd, enqueue, create } = makeSlskdWithSearch(
      [],
      [
        {
          username: 'freshpeer',
          freeUploadSlots: 1,
          queueLength: 0,
          uploadSpeed: 1000,
          files: [{ filename: 'Random/02 Song Two.flac', size: 1 }],
        },
      ],
    );
    insertExhausted(db);
    seedSong(db, 'Artist', 'Album', 'Song One'); // only track one is on disk

    const svc = new AlbumFallbackService(slskd, { db, autoRetryExhausted: true });
    await svc.sweep();

    expect(create).toHaveBeenCalledWith('Artist song two');
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [user] = enqueue.mock.calls[0];
    expect(user).toBe('freshpeer');
    expect(jobState(db)).toBe('active');
  });

  it('does not revive past the max-revives cap', () => {
    const { slskd } = makeSlskd([]);
    insertExhausted(db, { reviveCount: 2 });
    new AlbumFallbackService(slskd, {
      db,
      autoRetryExhausted: true,
      exhaustedMaxRevives: 2,
    }).reviveExhausted();
    expect(jobState(db)).toBe('exhausted');
  });

  it('does not revive within the cooldown window', () => {
    const { slskd } = makeSlskd([]);
    insertExhausted(db, { lastRevivedAt: Date.now() });
    new AlbumFallbackService(slskd, {
      db,
      autoRetryExhausted: true,
      exhaustedRetryCooldownMs: 3_600_000,
    }).reviveExhausted();
    expect(jobState(db)).toBe('exhausted');
  });

  it('does not revive a legacy job with no artist', () => {
    const { slskd } = makeSlskd([]);
    insertExhausted(db, { artist: null });
    new AlbumFallbackService(slskd, { db, autoRetryExhausted: true }).reviveExhausted();
    expect(jobState(db)).toBe('exhausted');
  });

  it('leaves exhausted jobs alone when autoRetryExhausted is off', async () => {
    const { slskd } = makeSlskd([]);
    insertExhausted(db);
    await new AlbumFallbackService(slskd, { db }).sweep();
    expect(jobState(db)).toBe('exhausted');
  });

  it('waits instead of re-searching when the missing track is already in flight', async () => {
    const { slskd, enqueue, create } = makeSlskdWithSearch(
      [
        {
          username: 'primary',
          directory: 'Album',
          files: [
            {
              id: 'p1',
              filename: 'Album/01 Song One.flac',
              size: 1,
              state: 'Completed, Succeeded',
            },
            { id: 'p2', filename: 'Album/02 Song Two.flac', size: 1, state: 'Completed, Errored' },
          ],
        },
        {
          // A prior fresh-search wave's download is still running on another peer.
          username: 'freshpeer',
          directory: 'Random',
          files: [{ id: 'f2', filename: 'Random/02 Song Two.flac', size: 1, state: 'InProgress' }],
        },
      ],
      [],
    );
    db.run(
      `INSERT INTO transfer_retries (transfer_key, username, filename, attempts, gave_up)
       VALUES ('primary::Album/02 Song Two.flac', 'primary', 'x', 3, 1)`,
    );
    AlbumFallbackService.recordJob(db, {
      lidarrAlbumId: 1,
      username: 'primary',
      directory: 'Album',
      artistName: 'Artist',
      canonicalTracks: ['Song One', 'Song Two'],
      targetFiles: [{ filename: 'Album/01 Song One.flac' }, { filename: 'Album/02 Song Two.flac' }],
      alternates: [],
    });

    const svc = new AlbumFallbackService(slskd, { db });
    await svc.sweep();

    expect(create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(attempts(db)).toBe(0);
    expect(jobState(db)).toBe('active');
  });
});
