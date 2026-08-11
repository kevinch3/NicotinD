import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import { Database } from 'bun:sqlite';
import { downloadRoutes } from './downloads.js';
import { albumIdFor } from '../services/library-scanner.js';
import { createJob } from '../services/acquisition-job-store.js';
import { ProviderRegistry } from '../services/provider-registry.js';
import { TestNetworkProvider } from '../test-helpers/network-provider.js';
import type { SlskdRef } from '../index.js';
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

    const slskdRef = { current: slskdMock } as unknown as SlskdRef;
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
    app.route('/', downloadRoutes(new ProviderRegistry(), pluginRegistry));

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

  it('refuses the action for a non-addon job', async () => {
    const { app } = makeAddonApp();
    const slskdJob = createJob(testDb, {
      kind: 'album-hunt',
      method: 'slskd',
      artistName: 'A',
      albumTitle: 'C',
      sourceRef: 'peer',
      files: [],
    });
    const res = await app.request(`/jobs/${slskdJob}/cancel`, { method: 'POST' });
    expect(res.status).toBe(400);
  });
});
