import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { downloadRoutes, enrichWithAlbumJobs } from './downloads.js';
import { albumIdFor } from '../services/library-scanner.js';
import { createJob } from '../services/acquisition-job-store.js';
import type { SlskdUserTransferGroup } from '@nicotind/core';
import { ProviderRegistry } from '../services/provider-registry.js';
import { SlskdSearchProvider } from '../services/providers/slskd-provider.js';
import type { SlskdRef } from '../index.js';
import { applySchema } from '../db.js';

// Mock getDatabase to use an in-memory DB
const testDb = new Database(':memory:');
applySchema(testDb);

mock.module('../db.js', () => ({
  getDatabase: () => testDb,
  applySchema,
}));

function makeSlskdMock() {
  return {
    transfers: {
      getDownloads: mock(() =>
        Promise.resolve([
          {
            username: 'user1',
            directories: [
              {
                directory: 'dir1',
                files: [
                  { id: 'guid1', filename: 'file1.mp3', state: 'Completed, Succeeded' },
                  { id: 'guid2', filename: 'file2.mp3', state: 'InProgress' },
                ],
              },
            ],
          },
        ]),
      ),
      enqueue: mock(() => Promise.resolve()),
      cancel: mock(() => Promise.resolve()),
      cancelAll: mock(() => Promise.resolve()),
    },
  };
}

describe('downloads routes', () => {
  let slskdMock: ReturnType<typeof makeSlskdMock>;
  let app: Hono;

  beforeEach(() => {
    testDb.run('DELETE FROM hidden_transfers');
    testDb.run('DELETE FROM album_jobs');
    testDb.run('DELETE FROM acquisition_job_items');
    testDb.run('DELETE FROM acquisition_jobs');

    slskdMock = makeSlskdMock();

    const slskdRef = { current: slskdMock } as unknown as SlskdRef;
    app = new Hono();
    const registry = new ProviderRegistry();
    registry.register(new SlskdSearchProvider(slskdRef));
    app.route('/', downloadRoutes(registry, slskdRef));
  });

  it('POST / wraps a direct grab in a lightweight acquisition job', async () => {
    testDb.run('DELETE FROM acquisition_jobs');
    testDb.run('DELETE FROM acquisition_job_items');
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'peerX',
        files: [{ filename: '@@x\\Music\\Some Artist\\Some Album\\01 Track.flac', size: 1 }],
      }),
    });
    expect(res.status).toBe(201);
    const job = testDb
      .query(`SELECT kind, method, artist_name, album_title, source_ref FROM acquisition_jobs`)
      .get() as {
      kind: string;
      method: string;
      artist_name: string | null;
      album_title: string | null;
      source_ref: string;
    };
    expect(job.kind).toBe('direct');
    expect(job.method).toBe('slskd');
    expect(job.source_ref).toBe('peerX');
    // Best-effort display hints from the peer's folder segments.
    expect(job.artist_name).toBe('Some Artist');
    expect(job.album_title).toBe('Some Album');
    const item = testDb.query(`SELECT transfer_key FROM acquisition_job_items`).get() as {
      transfer_key: string;
    };
    expect(item.transfer_key).toBe('peerX::@@x\\Music\\Some Artist\\Some Album\\01 Track.flac');
  });

  it('GET / returns all downloads when none are hidden', async () => {
    const res = await app.request('/');
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data[0].directories[0].files).toHaveLength(2);
  });

  it('GET / enriches a folder that matches an active album job with canonical metadata', async () => {
    testDb.run(
      `INSERT INTO album_jobs
        (lidarr_album_id, username, directory, canonical_tracks_json, alternates_json,
         artist_name, album_title, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      [
        1,
        'user1',
        'dir1',
        JSON.stringify(['a', 'b', 'c', 'd']),
        '[]',
        'Patricio Rey',
        'Oktubre',
        Date.now(),
      ],
    );

    const res = await app.request('/');
    const data = (await res.json()) as Array<{
      directories: Array<{
        albumJob?: {
          artistName: string;
          albumTitle: string;
          canonicalTrackCount: number;
          albumId: string;
        };
      }>;
    }>;

    expect(data[0].directories[0].albumJob).toEqual({
      artistName: 'Patricio Rey',
      albumTitle: 'Oktubre',
      canonicalTrackCount: 4,
      albumId: albumIdFor('Patricio Rey', 'Oktubre'),
    });
  });

  it('GET / enriches via stored acquisition-job transfer keys (no album_jobs row needed)', async () => {
    createJob(testDb, {
      kind: 'album-hunt',
      method: 'slskd',
      artistName: 'Bowie',
      albumTitle: 'Heathen',
      username: 'user1',
      canonicalTracks: ['a', 'b', 'c'],
      files: [{ filename: 'file1.mp3' }, { filename: 'file2.mp3' }],
    });

    const res = await app.request('/');
    const data = (await res.json()) as Array<{
      directories: Array<{
        albumJob?: { artistName: string; albumTitle: string; canonicalTrackCount: number };
      }>;
    }>;
    expect(data[0].directories[0].albumJob).toMatchObject({
      artistName: 'Bowie',
      albumTitle: 'Heathen',
      canonicalTrackCount: 3,
      albumId: albumIdFor('Bowie', 'Heathen'),
    });
  });

  it('GET /jobs returns the unified job feed with per-state progress', async () => {
    const id = createJob(testDb, {
      kind: 'album-hunt',
      method: 'slskd',
      artistName: 'Bowie',
      albumTitle: 'Heathen',
      username: 'user1',
      canonicalTracks: ['a', 'b'],
      files: [{ filename: 'file1.mp3' }, { filename: 'file2.mp3' }],
    });
    testDb.run(
      `UPDATE acquisition_job_items SET state = 'scanned', song_id = 's1' WHERE filename = 'file1.mp3'`,
    );

    const res = await app.request('/jobs');
    expect(res.status).toBe(200);
    const jobs = (await res.json()) as Array<{
      id: string;
      kind: string;
      method: string;
      state: string;
      stage: string;
      artistName: string | null;
      albumTitle: string | null;
      albumId: string | null;
      progress: { expected: number; delivered: number; unavailable: number; failed: number };
    }>;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe(id);
    expect(jobs[0].kind).toBe('album-hunt');
    expect(jobs[0].artistName).toBe('Bowie');
    expect(jobs[0].albumId).toBe(albumIdFor('Bowie', 'Heathen'));
    expect(jobs[0].progress).toEqual({ expected: 2, delivered: 1, unavailable: 0, failed: 0 });
  });

  it('GET / leaves direct (non-hunt) folders without albumJob metadata', async () => {
    const res = await app.request('/');
    const data = (await res.json()) as Array<{ directories: Array<{ albumJob?: unknown }> }>;
    expect(data[0].directories[0].albumJob).toBeUndefined();
  });

  it('GET / does not enrich folders whose job is no longer active', async () => {
    testDb.run(
      `INSERT INTO album_jobs
        (lidarr_album_id, username, directory, canonical_tracks_json, alternates_json,
         artist_name, album_title, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'done', ?)`,
      [1, 'user1', 'dir1', JSON.stringify(['a', 'b']), '[]', 'Patricio Rey', 'Oktubre', Date.now()],
    );

    const res = await app.request('/');
    const data = (await res.json()) as Array<{ directories: Array<{ albumJob?: unknown }> }>;
    expect(data[0].directories[0].albumJob).toBeUndefined();
  });

  it('GET / filters out hidden transfers', async () => {
    testDb.run('INSERT INTO hidden_transfers (id) VALUES (?)', ['guid1']);

    const res = await app.request('/');
    const data = (await res.json()) as Array<{
      directories: Array<{ files: Array<{ id: string }> }>;
    }>;

    expect(data[0].directories[0].files).toHaveLength(1);
    expect(data[0].directories[0].files[0].id).toBe('guid2');
  });

  it('DELETE /:username/:id adds to hidden_transfers and calls slskd cancel', async () => {
    const res = await app.request('/user1/guid1', { method: 'DELETE' });
    expect(res.status).toBe(200);

    const hidden = testDb.query('SELECT * FROM hidden_transfers WHERE id = ?').get('guid1');
    expect(hidden).toBeDefined();
    expect(slskdMock.transfers.cancel).toHaveBeenCalledWith('user1', 'guid1');
  });

  it('DELETE / cancels all transfers and hides them', async () => {
    const res = await app.request('/', { method: 'DELETE' });
    expect(res.status).toBe(200);

    // Both files should now be in hidden_transfers
    const hidden = testDb.query('SELECT id FROM hidden_transfers').all() as Array<{ id: string }>;
    const hiddenIds = hidden.map((h) => h.id);
    expect(hiddenIds).toContain('guid1');
    expect(hiddenIds).toContain('guid2');

    // cancel called once per file
    expect(slskdMock.transfers.cancel).toHaveBeenCalledWith('user1', 'guid1');
    expect(slskdMock.transfers.cancel).toHaveBeenCalledWith('user1', 'guid2');
  });

  it('GET / returns 503 when slskd throws (transient unreachable)', async () => {
    slskdMock.transfers.getDownloads = mock(() => Promise.reject(new Error('FailedToOpenSocket')));

    const res = await app.request('/');
    expect(res.status).toBe(503);
  });

  it('DELETE / preserves previously hidden IDs', async () => {
    // "guid3" was hidden before Cancel All (e.g. from a prior cancelled transfer)
    testDb.run('INSERT INTO hidden_transfers (id) VALUES (?)', ['guid3']);

    const res = await app.request('/', { method: 'DELETE' });
    expect(res.status).toBe(200);

    const hidden = testDb.query('SELECT id FROM hidden_transfers').all() as Array<{ id: string }>;
    const hiddenIds = hidden.map((h) => h.id);
    expect(hiddenIds).toContain('guid3');
  });
});

describe('enrichWithAlbumJobs', () => {
  beforeEach(() => {
    testDb.run('DELETE FROM album_jobs');
  });

  it('attaches a resolved albumId matching the destination album', () => {
    testDb.run(
      `INSERT INTO album_jobs
        (username, directory, artist_name, album_title, canonical_tracks_json, alternates_json,
         state, created_at)
       VALUES (?, ?, ?, ?, ?, '[]', 'active', ?)`,
      [
        'peer1',
        'wave1',
        'Lenny Kravitz',
        'Circus',
        JSON.stringify(['Circus', 'Believe']),
        Date.now(),
      ],
    );
    const groups: SlskdUserTransferGroup[] = [
      {
        username: 'peer1',
        directories: [{ directory: 'wave1', fileCount: 1, files: [] }],
      } as unknown as SlskdUserTransferGroup,
    ];
    const [group] = enrichWithAlbumJobs(testDb, groups);
    const meta = group!.directories[0]!.albumJob;
    expect(meta).toBeDefined();
    expect(meta!.albumId).toBe(albumIdFor('Lenny Kravitz', 'Circus'));
    expect(meta!.canonicalTrackCount).toBe(2);
  });
});
