import { describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { acquireAlbum } from './album-acquire.js';
import { albumIdFor, artistIdFor } from './library-scanner.js';
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

function makeDeps(opts: {
  db?: Database;
  candidates?: FolderCandidate[];
  tracks?: Array<{ title: string }>;
  slskd?: boolean;
  enqueueThrows?: boolean;
}) {
  const db = opts.db ?? makeDb();
  const tracks = opts.tracks ?? [{ title: 'Song One' }, { title: 'Song Two' }];
  const enqueue = mock(async () => {
    if (opts.enqueueThrows) throw new Error('peer offline');
  });
  const hunt = mock(async () => opts.candidates ?? []);
  const listByAlbum = mock(async () => tracks);
  const deps = {
    db,
    hunter: { hunt } as unknown as AlbumHunterService,
    lidarr: { track: { listByAlbum } } as unknown as Lidarr,
    slskdRef: (opts.slskd === false
      ? { current: null }
      : { current: { transfers: { enqueue } } }) as unknown as SlskdRef,
  };
  return { db, deps, enqueue, hunt, listByAlbum };
}

const input = { lidarrAlbumId: 99, artistName: 'Artist', albumTitle: 'Album', minMatchPct: 80 };

describe('acquireAlbum', () => {
  it('enqueues the best candidate and records a fallback job', async () => {
    const { db, deps, enqueue } = makeDeps({
      candidates: [candidate({ username: 'good', matchPct: 100 })],
    });

    const outcome = await acquireAlbum(deps, input);

    expect(outcome).toBe('enqueued');
    expect(enqueue).toHaveBeenCalledWith('good', expect.any(Array));
    const job = db.query('SELECT lidarr_album_id AS a FROM album_jobs').get() as { a: number };
    expect(job.a).toBe(99);
  });

  it('wraps the enqueue in a unified acquisition job linked to the fallback job', async () => {
    const { db, deps } = makeDeps({
      candidates: [candidate({ username: 'good', matchPct: 100 })],
    });

    await acquireAlbum(deps, { ...input, artistMbid: 'mbid-artist' });

    const job = db
      .query(
        `SELECT kind, method, artist_name, album_title, lidarr_album_id, artist_mbid, album_job_id, source_ref
         FROM acquisition_jobs`,
      )
      .get() as {
      kind: string;
      method: string;
      artist_name: string;
      album_title: string;
      lidarr_album_id: number;
      artist_mbid: string | null;
      album_job_id: number | null;
      source_ref: string;
    };
    expect(job.kind).toBe('auto-acquire');
    expect(job.method).toBe('slskd');
    expect(job.artist_name).toBe('Artist');
    expect(job.album_title).toBe('Album');
    expect(job.lidarr_album_id).toBe(99);
    expect(job.artist_mbid).toBe('mbid-artist');
    expect(job.source_ref).toBe('good');
    const albumJob = db.query(`SELECT id FROM album_jobs`).get() as { id: number };
    expect(job.album_job_id).toBe(albumJob.id);

    const item = db.query(`SELECT transfer_key FROM acquisition_job_items`).get() as {
      transfer_key: string;
    };
    expect(item.transfer_key).toBe('good::Artist/Album/01 Song.flac');
  });

  it('persists the acquired artist identity (+MBID) on enqueue', async () => {
    const { db, deps } = makeDeps({
      candidates: [candidate({ username: 'good', matchPct: 100 })],
    });

    const outcome = await acquireAlbum(deps, { ...input, artistMbid: 'mbid-artist' });

    expect(outcome).toBe('enqueued');
    const identity = db
      .query<{ raw_name: string; decision: string; source: string }, [string]>(
        'SELECT raw_name, decision, source FROM library_artist_identity WHERE artist_key = ?',
      )
      .get(artistIdFor('Artist'));
    expect(identity).toEqual({ raw_name: 'Artist', decision: 'single', source: 'lidarr' });
    const link = db
      .query<{ mbid: string }, [string]>(
        'SELECT mbid FROM artist_discography_links WHERE artist_id = ?',
      )
      .get(artistIdFor('Artist'));
    expect(link?.mbid).toBe('mbid-artist');
  });

  it('returns no-candidate when nothing clears the threshold (no enqueue)', async () => {
    const { deps, enqueue } = makeDeps({ candidates: [candidate({ matchPct: 50 })] });

    const outcome = await acquireAlbum(deps, input);

    expect(outcome).toBe('no-candidate');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('returns already-complete when the album is on disk (no hunt)', async () => {
    const db = makeDb();
    const albumId = albumIdFor('Artist', 'Album');
    db.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, created, synced_at)
       VALUES (?, 'Album', 'Artist', ?, 2, 0, '2024-01-01', 0)`,
      [albumId, artistIdFor('Artist')],
    );
    const { deps, enqueue, hunt } = makeDeps({ db });

    const outcome = await acquireAlbum(deps, input);

    expect(outcome).toBe('already-complete');
    expect(hunt).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('returns in-flight when a job is already active for the album (no hunt)', async () => {
    const db = makeDb();
    db.run(
      `INSERT INTO album_jobs (lidarr_album_id, username, directory, canonical_tracks_json, alternates_json, state, created_at)
       VALUES (99, 'u', 'd', '[]', '[]', 'active', 0)`,
    );
    const { deps, enqueue, hunt } = makeDeps({ db });

    const outcome = await acquireAlbum(deps, input);

    expect(outcome).toBe('in-flight');
    expect(hunt).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('returns slskd-unavailable when slskd is not connected', async () => {
    const { deps, hunt } = makeDeps({ slskd: false });

    const outcome = await acquireAlbum(deps, input);

    expect(outcome).toBe('slskd-unavailable');
    expect(hunt).not.toHaveBeenCalled();
  });

  it('returns enqueue-failed when the transfer enqueue throws', async () => {
    const { deps } = makeDeps({
      candidates: [candidate({ matchPct: 100 })],
      enqueueThrows: true,
    });

    const outcome = await acquireAlbum(deps, input);

    expect(outcome).toBe('enqueue-failed');
  });
});
