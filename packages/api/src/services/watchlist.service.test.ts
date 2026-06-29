import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { WatchlistService } from './watchlist.service.js';
import { albumIdFor, artistIdFor } from './library-scanner.js';
import type { CatalogService } from './catalog-search.service.js';
import type { AlbumHunterService, FolderCandidate } from './album-hunter.service.js';
import type { Lidarr } from '@nicotind/lidarr-client';
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

  const enqueue = mock(async () => undefined);
  const hunt = mock(async () => opts.candidates ?? []);
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
    hunter: { hunt } as unknown as AlbumHunterService,
    lidarr: { track: { listByAlbum } } as unknown as Lidarr,
    slskdRef: { current: { transfers: { enqueue } } } as unknown as SlskdRef,
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
      expect(enqueue).toHaveBeenCalledWith('good', expect.any(Array));
      expect(state(db)).toBe('acquired');
      // A fallback job is recorded so recovery + auto-retry apply.
      const job = db.query('SELECT lidarr_album_id AS a FROM album_jobs').get() as { a: number };
      expect(job.a).toBe(99);
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

    it('does not double-download when a job is already active for the album', async () => {
      const { db, svc, enqueue, hunt } = makeHarness({});
      watch(db, { lidarr_album_id: 99 });
      db.run(
        `INSERT INTO album_jobs (lidarr_album_id, username, directory, canonical_tracks_json, alternates_json, state, created_at)
         VALUES (99, 'u', 'd', '[]', '[]', 'active', 0)`,
      );

      await svc.sweep();

      expect(hunt).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
      expect(state(db)).toBe('acquired');
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
