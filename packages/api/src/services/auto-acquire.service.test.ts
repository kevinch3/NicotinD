import { describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { ADDON_PROTOCOL_VERSION } from '@nicotind/core';
import { RemoteAddonPlugin } from './addons/remote-addon-plugin.js';
import { AddonRequestError } from './addons/client.js';
import { AutoAcquireService } from './auto-acquire.service.js';
import type { FolderCandidate } from './album-hunter.service.js';
import type { Lidarr, LidarrAlbum } from '@nicotind/lidarr-client';

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
  // Since phase 3 the acquire runs through an addon: `hunt` backs
  // albums/search, `enqueue` backs job creation.
  const enqueue = mock(async () => ({ id: 'aj-1', intent: 'album', items: [] }));
  const hunt = mock(async () => opts.candidates ?? [candidate({ matchPct: 100 })]);
  const addon = new RemoteAddonPlugin(
    {
      id: 'slskd',
      name: 'slskd addon',
      description: 'x',
      version: '0.1.0',
      protocolVersion: ADDON_PROTOCOL_VERSION,
      kind: 'acquisition',
      capabilities: ['search', 'download'],
    },
    {
      baseUrl: 'http://addon:9999',
      albumsSearch: async () => {
        const candidates = (await hunt()) as FolderCandidate[];
        return {
          candidates: candidates.map((c, i) => ({
            candidateRef: `ref-${i}`,
            username: c.username,
            directory: c.directory,
            matchedTracks: c.matchedTracks,
            totalTracks: c.totalTracks,
            matchPct: c.matchPct,
            format: c.format,
            estimatedSizeMb: c.estimatedSizeMb,
            isLive: c.isLive,
            files: c.files.map((f) => ({ filename: f.filename, size: f.size })),
          })),
          queries: [],
          skewNeeded: false,
        };
      },
      createJob: enqueue,
    } as unknown as import('./addons/client.js').AddonClient,
  );
  const listByAlbum = mock(async () => [{ title: 'Song One' }, { title: 'Song Two' }]);
  const wantedMissing = mock(async () => opts.missing ?? []);

  const svc = new AutoAcquireService({
    db,
    lidarr: { album: { wantedMissing }, track: { listByAlbum } } as unknown as Lidarr,
    getAddon: () => addon,
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

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ intent: 'album', candidateRef: 'ref-0' }),
      'acquire:99',
    );
    const job = db.query('SELECT lidarr_album_id AS a, method FROM acquisition_jobs').get() as {
      a: number;
      method: string;
    };
    expect(job.a).toBe(99);
    expect(job.method).toBe('slskd');

    // Second sweep: the addon's per-album 409 is the in-flight guard now —
    // the sweep re-asks, gets conflict, and records no duplicate feed row.
    enqueue.mockImplementation(async () => {
      throw new AddonRequestError('conflict', 409);
    });
    await svc.sweep();
    expect(db.query('SELECT id FROM acquisition_jobs').all()).toHaveLength(1);
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
