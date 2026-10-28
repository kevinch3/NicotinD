import { describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { ADDON_PROTOCOL_VERSION } from '@nicotind/core';
import { RemoteAddonPlugin } from './addons/remote-addon-plugin.js';
import { AddonRequestError } from './addons/client.js';
import {
  AUTO_ACQUIRE_MAX_PAGES,
  AUTO_ACQUIRE_PAGE_SIZE,
  AutoAcquireService,
} from './auto-acquire.service.js';
import { albumIdFor, artistIdFor } from './library-scanner.js';
import type { Lidarr, LidarrAlbum } from '../lidarr/index.js';

// Local fixture shape (the addon owns the real FolderCandidate; api no longer
// depends on @nicotind/slskd-addon — the hunt runs addon-side over the protocol).
interface FolderCandidate {
  directory: string;
  username: string;
  files: Array<{ filename: string; size: number }>;
  matchedTracks: number;
  totalTracks: number;
  matchPct: number;
  format: string;
  estimatedSizeMb: number;
  isLive: boolean;
  freeUploadSlots: number;
  queueLength: number;
  uploadSpeed: number;
}

function makeDb(): Database {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
}

function candidate(overrides: Partial<FolderCandidate>): FolderCandidate {
  return {
    directory: 'Artist/Album',
    username: 'peer',
    // Real track names: the addon refuses a folder carrying none of the wanted
    // tracks, and so does the pick now (#1209).
    files: [
      { filename: 'Artist/Album/01 Song One.flac', size: 1 },
      { filename: 'Artist/Album/02 Song Two.flac', size: 1 },
    ],
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

/** A missing-list record Lidarr reports with its track total. */
function missingWithTotal(id: number, title: string, artistName: string, total: number) {
  return {
    ...missing(id, title, artistName),
    statistics: { trackCount: 0, totalTrackCount: total, sizeOnDisk: 0, percentOfTracks: 0 },
  } as LidarrAlbum;
}

/** An album the library already holds in full. */
function own(db: Database, artist: string, title: string, songs: number) {
  db.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, classification, synced_at)
     VALUES (?, ?, ?, ?, ?, 0, 'album', 0)`,
    [albumIdFor(artist, title), title, artist, artistIdFor(artist), songs],
  );
}

function makeHarness(opts: {
  missing?: LidarrAlbum[];
  /** Lidarr's missing list split into pages (1-based by index + 1). */
  pages?: LidarrAlbum[][];
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
  // Honours the page size, as Lidarr does.
  const wantedMissing = mock(async (page: number, pageSize: number) =>
    (opts.pages ? (opts.pages[page - 1] ?? []) : page === 1 ? (opts.missing ?? []) : []).slice(
      0,
      pageSize,
    ),
  );

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

  it('reads the missing list in fixed pages, whatever maxPerSweep is', async () => {
    const { svc, wantedMissing } = makeHarness({ maxPerSweep: 5 });
    await svc.sweep();
    expect(wantedMissing).toHaveBeenCalledWith(1, AUTO_ACQUIRE_PAGE_SIZE);
  });

  /**
   * #1580: Lidarr's "missing" is its own file scan, and once its root folder is
   * kept off the library it sees no files at all — every album reads as missing.
   * Page 1 would then be albums the library already holds, forever.
   */
  it('pages past albums the library already owns to reach a missing one', async () => {
    const owned = Array.from({ length: AUTO_ACQUIRE_PAGE_SIZE }, (_, i) =>
      missingWithTotal(i + 1, `Owned ${i}`, 'Artist', 2),
    );
    const { db, svc, enqueue } = makeHarness({
      pages: [owned, [missingWithTotal(999, 'Album', 'Artist', 2)]],
      candidates: [candidate({ matchPct: 100 })],
    });
    for (let i = 0; i < AUTO_ACQUIRE_PAGE_SIZE; i++) own(db, 'Artist', `Owned ${i}`, 2);

    await svc.sweep();

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(expect.anything(), 'acquire:999');
  });

  it('does not spend the per-sweep budget on albums that turn out to be complete', async () => {
    // No statistics on the record: only acquireAlbum's own check can tell.
    const { db, svc, enqueue } = makeHarness({
      missing: [missing(1, 'Owned', 'Artist'), missing(2, 'Album', 'Artist')],
      maxPerSweep: 1,
    });
    own(db, 'Artist', 'Owned', 2);

    await svc.sweep();

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(expect.anything(), 'acquire:2');
  });

  it('carries on from the next page on the following sweep', async () => {
    const page = (offset: number) =>
      Array.from({ length: AUTO_ACQUIRE_PAGE_SIZE }, (_, i) =>
        missingWithTotal(offset + i, `Owned ${offset + i}`, 'Artist', 2),
      );
    const pages = Array.from({ length: AUTO_ACQUIRE_MAX_PAGES + 1 }, (_, p) =>
      page(p * AUTO_ACQUIRE_PAGE_SIZE + 1),
    );
    const { db, svc, wantedMissing } = makeHarness({ pages });
    for (const p of pages) for (const a of p) own(db, 'Artist', a.title, 2);

    await svc.sweep();
    await svc.sweep();

    const asked = wantedMissing.mock.calls.map((c) => c[0]);
    expect(asked.slice(0, AUTO_ACQUIRE_MAX_PAGES)).toEqual(
      Array.from({ length: AUTO_ACQUIRE_MAX_PAGES }, (_, i) => i + 1),
    );
    expect(asked[AUTO_ACQUIRE_MAX_PAGES]).toBe(AUTO_ACQUIRE_MAX_PAGES + 1);
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
