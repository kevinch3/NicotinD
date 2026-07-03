import { describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { AutoAcquireService } from './auto-acquire.service.js';
import type { AlbumHunterService, FolderCandidate } from './album-hunter.service.js';
import type { Lidarr, LidarrAlbum } from '@nicotind/lidarr-client';
import type { SlskdRef } from '../index.js';

function makeDb(): Database {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
}

function candidate(overrides: Partial<FolderCandidate>): FolderCandidate {
  return {
    directory: 'Artist/Album',
    username: 'peer',
    files: [{ filename: 'Artist/Album/01 Song.flac', size: 1 }],
    matchedTracks: 10,
    totalTracks: 10,
    matchPct: 100,
    format: 'FLAC',
    estimatedSizeMb: 100,
    isLive: false,
    freeUploadSlots: 1,
    queueLength: 0,
    uploadSpeed: 1,
    ...overrides,
  } as FolderCandidate;
}

function missing(id: number, title: string, artistName: string): LidarrAlbum {
  return {
    id,
    foreignAlbumId: `fa${id}`,
    title,
    albumType: 'Album',
    monitored: true,
    artist: { artistName } as LidarrAlbum['artist'],
  } as LidarrAlbum;
}

function makeHarness(opts: {
  missing?: LidarrAlbum[];
  candidates?: FolderCandidate[];
  isAcquisitionEnabled?: () => boolean;
  maxPerSweep?: number;
}) {
  const db = makeDb();
  const enqueue = mock(async () => undefined);
  const hunt = mock(async () => opts.candidates ?? [candidate({ matchPct: 100 })]);
  const listByAlbum = mock(async () => [{ title: 'Song One' }, { title: 'Song Two' }]);
  const wantedMissing = mock(async () => opts.missing ?? []);

  const svc = new AutoAcquireService({
    db,
    hunter: { hunt } as unknown as AlbumHunterService,
    lidarr: { album: { wantedMissing }, track: { listByAlbum } } as unknown as Lidarr,
    slskdRef: { current: { transfers: { enqueue } } } as unknown as SlskdRef,
    maxPerSweep: opts.maxPerSweep ?? 3,
    minMatchPct: 80,
    isAcquisitionEnabled: opts.isAcquisitionEnabled,
  });

  return { db, svc, enqueue, hunt, wantedMissing };
}

describe('AutoAcquireService.sweep', () => {
  it('acquires a confident missing album exactly once', async () => {
    const { db, svc, enqueue } = makeHarness({
      missing: [missing(99, 'Album', 'Artist')],
      candidates: [candidate({ username: 'good', matchPct: 100 })],
    });

    await svc.sweep();

    expect(enqueue).toHaveBeenCalledWith('good', expect.any(Array));
    const job = db.query('SELECT lidarr_album_id AS a FROM album_jobs').get() as { a: number };
    expect(job.a).toBe(99);

    // Second sweep sees the active job → in-flight, no duplicate enqueue.
    enqueue.mockClear();
    await svc.sweep();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('passes maxPerSweep to Lidarr as the page size', async () => {
    const { svc, wantedMissing } = makeHarness({ maxPerSweep: 5 });
    await svc.sweep();
    expect(wantedMissing).toHaveBeenCalledWith(1, 5);
  });

  it('enqueues nothing when no candidate clears the threshold', async () => {
    const { svc, enqueue } = makeHarness({
      missing: [missing(99, 'Album', 'Artist')],
      candidates: [candidate({ matchPct: 40 })],
    });

    await svc.sweep();

    expect(enqueue).not.toHaveBeenCalled();
  });

  it('skips the whole sweep when acquisition is disabled', async () => {
    const { svc, wantedMissing } = makeHarness({
      missing: [missing(99, 'Album', 'Artist')],
      isAcquisitionEnabled: () => false,
    });

    await svc.sweep();

    expect(wantedMissing).not.toHaveBeenCalled();
  });

  it('skips records missing an artist name', async () => {
    const { svc, hunt } = makeHarness({
      missing: [{ id: 5, title: 'Orphan', albumType: 'Album', monitored: true } as LidarrAlbum],
    });

    await svc.sweep();

    expect(hunt).not.toHaveBeenCalled();
  });
});
