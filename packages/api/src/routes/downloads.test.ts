import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import { Database } from 'bun:sqlite';
import { downloadRoutes } from './downloads.js';
import { albumIdFor } from '../services/library-scanner.js';
import { createJob } from '../services/acquisition-job-store.js';
import { ProviderRegistry } from '../services/provider-registry.js';
import { TestNetworkProvider } from '../test-helpers/network-provider.js';
import { applySchema } from '../db.js';
import { RemoteAddonPlugin } from '../services/addons/remote-addon-plugin.js';
import { PluginRegistry } from '../services/plugins/registry.js';

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
      removeCompleted: mock(() => Promise.resolve()),
    },
  };
}

describe('downloads routes', () => {
  let slskdMock: ReturnType<typeof makeSlskdMock>;
  let app: Hono<AuthEnv>;

  beforeEach(() => {
    testDb.run('DELETE FROM hidden_transfers');
    testDb.run('DELETE FROM album_jobs');
    testDb.run('DELETE FROM acquisition_job_items');
    testDb.run('DELETE FROM acquisition_jobs');

    slskdMock = makeSlskdMock();

    const slskdRef = { current: slskdMock } as never;
    app = new Hono<AuthEnv>();
    // Downloads is acquisition-gated; inject an acquiring user (not a listener).
    app.use('*', (c, next) => {
      c.set('user', { sub: 'u', role: 'user', iat: 0, exp: 9999999999 });
      return next();
    });
    const registry = new ProviderRegistry();
    registry.register(new TestNetworkProvider(slskdRef));
    void slskdMock;
    app.route('/', downloadRoutes(registry));
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

  // #674: a peer sharing out of their own slskd downloads dir exposes junk
  // segments ("complete") that used to land verbatim as the artist hint — and
  // a non-NULL junk hint blocks the poller's COALESCE backfill of the addon's
  // real metadata forever. Generic segments must store NULL, which self-heals.
  it('POST / stores no artist/album hint for generic path segments', async () => {
    testDb.run('DELETE FROM acquisition_jobs');
    testDb.run('DELETE FROM acquisition_job_items');
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'DjSan',
        files: [{ filename: '@@x\\complete\\BODAS 2024 (DJ ROBERT)\\Pedro.mp3', size: 1 }],
      }),
    });
    expect(res.status).toBe(201);
    const job = testDb.query(`SELECT artist_name, album_title FROM acquisition_jobs`).get() as {
      artist_name: string | null;
      album_title: string | null;
    };
    expect(job.artist_name).toBeNull();
    expect(job.album_title).toBe('BODAS 2024 (DJ ROBERT)');

    testDb.run('DELETE FROM acquisition_jobs');
    testDb.run('DELETE FROM acquisition_job_items');
    const res2 = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'DjSan',
        files: [{ filename: 'Some Artist\\FLAC\\01 Track.flac', size: 1 }],
      }),
    });
    expect(res2.status).toBe(201);
    const job2 = testDb.query(`SELECT artist_name, album_title FROM acquisition_jobs`).get() as {
      artist_name: string | null;
      album_title: string | null;
    };
    expect(job2.artist_name).toBe('Some Artist');
    expect(job2.album_title).toBeNull();
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
    // No such album is in the library, so the feed offers no deep link rather
    // than a name-derived id that cannot resolve (issue #468).
    expect(jobs[0].albumId).toBeNull();
    expect(jobs[0].progress).toEqual({ expected: 2, delivered: 1, unavailable: 0, failed: 0 });
  });

  it('GET /jobs deep-links to the album once the job has actually landed', async () => {
    const id = createJob(testDb, {
      kind: 'album-hunt',
      method: 'slskd',
      artistName: 'Bowie',
      albumTitle: 'Heathen',
      username: 'user1',
      files: [{ filename: 'file1.mp3' }],
    });
    const albumId = albumIdFor('Bowie', 'Heathen');
    testDb.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
       VALUES (?, 'Heathen', 'Bowie', 'art', 1, 0, 1)`,
      [albumId],
    );
    testDb.run(
      `INSERT INTO library_songs (id, album_id, artist_id, path, artist, title, synced_at)
       VALUES ('s9', ?, 'art', 'p/1.opus', 'Bowie', 'A', 1)`,
      [albumId],
    );
    testDb.run(
      `UPDATE acquisition_job_items SET state = 'scanned', song_id = 's9' WHERE job_id = ?`,
      [id],
    );

    const res = await app.request('/jobs');
    const jobs = (await res.json()) as Array<{ id: string; albumId: string | null }>;
    expect(jobs.find((j) => j.id === id)!.albumId).toBe(albumId);
  });
});

describe('addon job actions (acquisition addon protocol phase 2)', () => {
  const MANIFEST = {
    id: 'fixture-addon',
    name: 'Fixture',
    description: 'x',
    version: '0.1.0',
    protocolVersion: '1.0.0',
    kind: 'acquisition',
    capabilities: ['search', 'download'],
  } as import('@nicotind/core').AddonManifest;

  function makeAddonApp() {
    testDb.run('DELETE FROM acquisition_job_items');
    testDb.run('DELETE FROM acquisition_jobs');
    testDb.run('DELETE FROM plugins');
    const calls = { cancelled: [] as string[], deleted: [] as string[] };
    const client = {
      baseUrl: 'http://addon:9999',
      cancelJob: async (id: string) => {
        calls.cancelled.push(id);
      },
      deleteJob: async (id: string) => {
        calls.deleted.push(id);
      },
    } as unknown as import('../services/addons/client.js').AddonClient;
    const plugin = new RemoteAddonPlugin(MANIFEST, client);
    const pluginRegistry = new PluginRegistry({ db: testDb, dataDir: '/tmp/nicotind-test' });
    pluginRegistry.register(plugin);

    const app = new Hono<AuthEnv>();
    app.use('*', (c, next) => {
      c.set('user', { sub: 'u', role: 'user', iat: 0, exp: 9999999999 });
      return next();
    });
    // The addon is also the raw-lane network provider: its `download` creates
    // a browse-grab job addon-side and hands back the id.
    const providers = new ProviderRegistry();
    providers.register({
      name: 'fixture-addon',
      type: 'network',
      search: async () => [],
      download: async () => ({ addonJobId: 'grab-1' }),
      isAvailable: async () => true,
    } as unknown as import('@nicotind/core').ISearchProvider);
    app.route('/', downloadRoutes(providers, pluginRegistry));

    const jobId = createJob(testDb, {
      kind: 'album-hunt',
      method: 'fixture-addon',
      artistName: 'A',
      albumTitle: 'B',
      sourceRef: 'addon:fixture-addon:aj-7',
      files: [],
    });
    return { app, calls, jobId };
  }

  it('cancels an addon job via the owning addon', async () => {
    const { app, calls, jobId } = makeAddonApp();
    const res = await app.request(`/jobs/${jobId}/cancel`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(calls.cancelled).toEqual(['aj-7']);
  });

  it('deletes an addon job on both sides', async () => {
    const { app, calls, jobId } = makeAddonApp();
    const res = await app.request(`/jobs/${jobId}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(calls.cancelled).toEqual(['aj-7']);
    expect(calls.deleted).toEqual(['aj-7']);
    expect(testDb.query(`SELECT id FROM acquisition_jobs`).all()).toHaveLength(0);
  });

  // A row no addon owns (a pre-linkage direct grab whose `source_ref` is the
  // peer name, or any legacy peer-ref row) used to 400 here, so "Cancel all"
  // could never close it — prod: a 31-track folder grab sat "Downloading 0 of
  // 31" for hours while its files were long landed (via the poller's twin row).
  // Core owns the row, so core closes it: in-flight items → unavailable and the
  // job ends as an honest failure the user can then clear.
  it('cancel on a non-addon job closes it core-side instead of refusing', async () => {
    const { app } = makeAddonApp();
    const slskdJob = createJob(testDb, {
      kind: 'direct',
      method: 'slskd',
      artistName: 'A',
      albumTitle: 'C',
      sourceRef: 'peer',
      username: 'peer',
      files: [
        { filename: 'a\\01.flac', size: 1 },
        { filename: 'a\\02.flac', size: 1 },
      ],
    });
    const res = await app.request(`/jobs/${slskdJob}/cancel`, { method: 'POST' });
    expect(res.status).toBe(200);
    const job = testDb
      .query<{ state: string; stage: string; error: string | null }, [string]>(
        `SELECT state, stage, error FROM acquisition_jobs WHERE id = ?`,
      )
      .get(slskdJob)!;
    expect(job.state).toBe('failed');
    expect(job.stage).toBe('error');
    expect(job.error).toMatch(/cancel/i);
    const states = testDb
      .query<{ state: string }, [string]>(
        `SELECT DISTINCT state FROM acquisition_job_items WHERE job_id = ?`,
      )
      .all(slskdJob)
      .map((r) => r.state);
    expect(states).toEqual(['unavailable']);
  });

  // The raw-lane grab asks the addon to create a browse-grab job, then used to
  // throw the returned job id away and record the peer name as `source_ref`.
  // The poller, seeing an addon job it had never mapped, minted its own mirror
  // row — so one grab rendered as two cards, and the route's twin (the one the
  // user sees first) was never updated and could never be cancelled.
  it('POST / links a direct grab to the addon job that runs it', async () => {
    const { app, calls } = makeAddonApp();
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'peerX',
        files: [{ filename: 'Music\\Artist\\Album\\01.flac', size: 1 }],
      }),
    });
    expect(res.status).toBe(201);
    const job = testDb
      .query<{ id: string; source_ref: string; method: string }, []>(
        `SELECT id, source_ref, method FROM acquisition_jobs WHERE kind = 'direct'`,
      )
      .get()!;
    expect(job.method).toBe('fixture-addon');
    expect(job.source_ref).toBe('addon:fixture-addon:grab-1');
    // Pre-mapped for the poller, so it mirrors into THIS row instead of a twin.
    const mapped = testDb
      .query<{ value: string }, [string, string]>(
        `SELECT value FROM plugin_kv WHERE plugin_id = ? AND key = ?`,
      )
      .get('addon-poller:fixture-addon', 'jobmap:grab-1');
    expect(mapped?.value).toBe(job.id);
    // …and Cancel now reaches the addon.
    const cancel = await app.request(`/jobs/${job.id}/cancel`, { method: 'POST' });
    expect(cancel.status).toBe(200);
    expect(calls.cancelled).toEqual(['grab-1']);
  });

  // Issue #533: DELETE used to 400 on any row without an `addon:` source_ref —
  // every pre-cutover row (peer-username refs) and every url mirror row — and
  // the referenced "transfer routes" no longer exist, so those cards were
  // permanently un-removable ("old downloads I can't remove").
  it('DELETE removes a legacy peer-ref row without touching any addon', async () => {
    const { app, calls } = makeAddonApp();
    const legacy = createJob(testDb, {
      kind: 'album-hunt',
      method: 'slskd',
      artistName: 'Bandana',
      albumTitle: 'Vivir intentando',
      sourceRef: 'chaozz777',
      files: [],
    });
    const res = await app.request(`/jobs/${legacy}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(calls.cancelled).toEqual([]);
    expect(calls.deleted).toEqual([]);
    expect(testDb.query(`SELECT id FROM acquisition_jobs WHERE id = ?`).all(legacy)).toHaveLength(
      0,
    );
  });

  it('DELETE removes a url-mirror row (sourceRef is the URL)', async () => {
    const { app } = makeAddonApp();
    const urlJob = createJob(testDb, {
      kind: 'url',
      method: 'spotdl-addon',
      artistName: null,
      albumTitle: null,
      sourceRef: 'https://open.spotify.com/album/xyz',
      files: [],
    });
    const res = await app.request(`/jobs/${urlJob}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(testDb.query(`SELECT id FROM acquisition_jobs WHERE id = ?`).all(urlJob)).toHaveLength(
      0,
    );
  });
});
