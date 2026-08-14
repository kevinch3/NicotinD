import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { ADDON_PROTOCOL_VERSION } from '@nicotind/core';
import { RemoteAddonPlugin } from './addons/remote-addon-plugin.js';
import { AddonRequestError } from './addons/client.js';
import { WatchlistService } from './watchlist.service.js';
import { albumIdFor, artistIdFor } from './library-scanner.js';
import type { CatalogService } from './catalog-search.service.js';
import type { Lidarr } from '@nicotind/lidarr-client';

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

interface Harness {
  db: Database;
  svc: WatchlistService;
  enqueue: ReturnType<typeof mock>;
  hunt: ReturnType<typeof mock>;
  resolveAlbum: ReturnType<typeof mock>;
  listByAlbum: ReturnType<typeof mock>;
}

function makeHarness(opts: {
  candidates?: FolderCandidate[];
  tracks?: Array<{ title: string }>;
  minMatchPct?: number;
  resolveAlbumId?: number;
}): Harness {
  const db = makeDb();
  const tracks = opts.tracks ?? [{ title: 'Song One' }, { title: 'Song Two' }];

  // Since phase 3 the hunt runs addon-side: `hunt` backs the addon's
  // albums/search (mapped to protocol candidates) and `enqueue` its job
  // creation, so the sweep-semantics assertions below survive unchanged.
  const enqueue = mock(async () => ({ id: 'aj-1', intent: 'album', items: [] }));
  const hunt = mock(async () => opts.candidates ?? []);
  const addonClient = {
    baseUrl: 'http://addon:9999',
    albumsSearch: async (req: { artist: string; album: string }) => {
      void req;
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
  };
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
    addonClient as unknown as import('./addons/client.js').AddonClient,
  );
  const resolveAlbum = mock(async () => ({
    lidarrAlbumId: opts.resolveAlbumId ?? 99,
    totalTracks: tracks.length,
    title: 'Album',
    artistName: 'Artist',
  }));
  const listByAlbum = mock(async () => tracks);

  const svc = new WatchlistService({
    db,
    catalog: { resolveAlbum } as unknown as CatalogService,
    lidarr: { track: { listByAlbum } } as unknown as Lidarr,
    getAddon: () => addon,
    minMatchPct: opts.minMatchPct ?? 80,
  });

  return { db, svc, enqueue, hunt, resolveAlbum, listByAlbum };
}

function watch(db: Database, over: Partial<Record<string, unknown>> = {}): void {
  db.run(
    `INSERT INTO watchlist (foreign_album_id, artist_mbid, artist_name, album_title, lidarr_album_id, state, created_at)
     VALUES (?, ?, ?, ?, ?, 'watching', ?)`,
    [
      (over.foreign_album_id as string) ?? 'fa1',
      (over.artist_mbid as string) ?? 'mb1',
      (over.artist_name as string) ?? 'Artist',
      (over.album_title as string) ?? 'Album',
      (over.lidarr_album_id as number) ?? null,
      Date.now(),
    ],
  );
}

function state(db: Database): string {
  return (db.query('SELECT state FROM watchlist WHERE id = 1').get() as { state: string }).state;
}

describe('WatchlistService', () => {
  describe('add', () => {
    let db: Database;
    let svc: WatchlistService;
    beforeEach(() => {
      ({ db, svc } = makeHarness({}));
    });

    it('inserts a new watch and is idempotent on foreignAlbumId', () => {
      const a = svc.add({
        foreignAlbumId: 'fa1',
        artistMbid: 'mb',
        artistName: 'A',
        albumTitle: 'B',
      });
      const b = svc.add({
        foreignAlbumId: 'fa1',
        artistMbid: 'mb',
        artistName: 'A',
        albumTitle: 'B',
      });
      expect(a.id).toBe(b.id);
      expect(svc.list()).toHaveLength(1);
    });

    it('re-arms an acquired entry back to watching', () => {
      const row = svc.add({ foreignAlbumId: 'fa1', artistName: 'A', albumTitle: 'B' });
      db.run(`UPDATE watchlist SET state = 'acquired' WHERE id = ?`, [row.id]);
      const again = svc.add({ foreignAlbumId: 'fa1', artistName: 'A', albumTitle: 'B' });
      expect(again.state).toBe('watching');
    });

    it('remove deletes the row', () => {
      const row = svc.add({ foreignAlbumId: 'fa1', artistName: 'A', albumTitle: 'B' });
      expect(svc.remove(row.id)).toBe(true);
      expect(svc.list()).toHaveLength(0);
    });
  });

  describe('sweep', () => {
    it('auto-acquires when a candidate clears the confidence threshold', async () => {
      const { db, svc, enqueue, hunt } = makeHarness({
        candidates: [candidate({ username: 'good', matchPct: 100 })],
      });
      watch(db, { lidarr_album_id: 99 });

      await svc.sweep();

      expect(hunt).toHaveBeenCalled();
      // Since phase 3 the acquire is an addon job: the user's pick travels as a
      // candidateRef and the unified feed row is recorded core-side (the
      // fallback job lives in the addon's own db now).
      expect(enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ intent: 'album', candidateRef: 'ref-0' }),
        'acquire:99',
      );
      expect(state(db)).toBe('acquired');
      const feed = db.query(`SELECT method, lidarr_album_id AS a FROM acquisition_jobs`).get() as {
        method: string;
        a: number;
      };
      expect(feed.method).toBe('slskd');
      expect(feed.a).toBe(99);
    });

    it('leaves the row watching when no candidate clears the threshold', async () => {
      const { db, svc, enqueue } = makeHarness({
        candidates: [candidate({ matchPct: 50 })],
        minMatchPct: 80,
      });
      watch(db, { lidarr_album_id: 99 });

      await svc.sweep();

      expect(enqueue).not.toHaveBeenCalled();
      expect(state(db)).toBe('watching');
      // last_checked_at recorded so the UI can show progress.
      const r = db.query('SELECT last_checked_at AS t FROM watchlist WHERE id = 1').get() as {
        t: number;
      };
      expect(r.t).toBeGreaterThan(0);
    });

    it('marks acquired without downloading when the album is already on disk', async () => {
      const { db, svc, enqueue, hunt } = makeHarness({});
      watch(db, { lidarr_album_id: 99 });
      // Seed the library so albumAlreadyComplete returns true.
      const albumId = albumIdFor('Artist', 'Album');
      db.run(
        `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, created, synced_at)
         VALUES (?, 'Album', 'Artist', ?, 2, 0, '2024-01-01', 0)`,
        [albumId, artistIdFor('Artist')],
      );

      await svc.sweep();

      expect(hunt).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
      expect(state(db)).toBe('acquired');
    });

    it("treats the addon's per-album 409 as already-downloading (no duplicate)", async () => {
      // Since phase 3 the in-flight guard is the addon's own 409 — a duplicate
      // sweep hunts (it cannot know beforehand) but never double-enqueues.
      const { db, svc, enqueue, hunt } = makeHarness({
        candidates: [candidate({ username: 'good', matchPct: 100 })],
      });
      enqueue.mockImplementation(async () => {
        throw new AddonRequestError('conflict', 409);
      });
      watch(db, { lidarr_album_id: 99 });

      await svc.sweep();

      expect(hunt).toHaveBeenCalled();
      expect(state(db)).toBe('acquired');
      expect(db.query(`SELECT id FROM acquisition_jobs`).all()).toHaveLength(0);
    });

    it('resolves the Lidarr album id on demand and caches it', async () => {
      const { db, svc, resolveAlbum } = makeHarness({
        candidates: [candidate({ matchPct: 100 })],
        resolveAlbumId: 123,
      });
      watch(db, { lidarr_album_id: null }); // unresolved

      await svc.sweep();

      expect(resolveAlbum).toHaveBeenCalled();
      const r = db.query('SELECT lidarr_album_id AS a FROM watchlist WHERE id = 1').get() as {
        a: number;
      };
      expect(r.a).toBe(123);
    });
  });
});
