import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Hono } from 'hono';
import { ADDON_PROTOCOL_VERSION, type AddonManifest } from '@nicotind/core';
import type { Lidarr } from '../lidarr/index.js';
import type { AuthEnv } from '../middleware/auth.js';
import { applySchema } from '../db.js';
import { discographyRoutes } from '../routes/discography.js';
import type { DiscographyService } from './discography.service.js';
import type { ArtistProvisioningService } from './artist-provisioning.service.js';
import type { AlbumHuntOrchestrator } from './source-hunter.js';
import { RemoteAddonPlugin } from './addons/remote-addon-plugin.js';
import type { AddonClient } from './addons/client.js';
import { cancelUnownedJob } from './acquisition-job-store.js';
import { AlbumGetService } from './album-get.service.js';
import { albumGetRetryDelayMs } from './album-get-retry.js';

const MANIFEST: AddonManifest = {
  id: 'fixture-addon',
  name: 'Fixture',
  description: 'x',
  version: '0.1.0',
  protocolVersion: ADDON_PROTOCOL_VERSION,
  kind: 'acquisition',
  capabilities: ['search', 'download'],
};

const CANDIDATE = {
  candidateRef: 'ref-1',
  username: 'peer',
  directory: 'Music\\Album',
  matchedTracks: 2,
  totalTracks: 2,
  matchPct: 100,
  format: 'FLAC',
  estimatedSizeMb: 10,
  isLive: false,
  files: [
    { filename: 'Music\\Album\\01 - Song One.flac', size: 1 },
    { filename: 'Music\\Album\\02 - Song Two.flac', size: 1 },
  ],
};
const FOUND = { candidates: [CANDIDATE], queries: [], skewNeeded: false };
const NOTHING = { candidates: [], queries: [], skewNeeded: false };
const OFFLINE = { ...NOTHING, sourceOffline: true };

type JobRow = {
  id: string;
  state: string;
  stage: string;
  error: string | null;
  source_ref: string | null;
};

function harness(searches: Array<typeof FOUND | typeof OFFLINE>, opts: { addon?: boolean } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  let searchCalls = 0;
  let jobCalls = 0;
  const client = {
    baseUrl: 'http://addon:9999',
    albumsSearch: async () => searches[Math.min(searchCalls++, searches.length - 1)],
    createJob: async () => {
      jobCalls++;
      return { id: 'aj-1', intent: 'album', items: [] };
    },
  } as unknown as AddonClient;
  const addon = new RemoteAddonPlugin(MANIFEST, client);
  const lidarr = {
    album: { get: async () => ({ title: 'Album', artist: { artistName: 'Artist' } }) },
    track: { listByAlbum: async () => [{ title: 'Song One' }, { title: 'Song Two' }] },
  } as unknown as Lidarr;
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const svc = new AlbumGetService({
    db,
    lidarr,
    getAddon: () => (opts.addon === false ? null : addon),
    schedule: (fn, ms) => timers.push({ fn, ms }),
  });
  const rows = () =>
    db.query<JobRow, []>(`SELECT id, state, stage, error, source_ref FROM acquisition_jobs`).all();
  return {
    db,
    svc,
    lidarr,
    addon,
    timers,
    rows,
    calls: () => ({ searchCalls, jobCalls }),
  };
}

const REQ = { lidarrAlbumId: 42, userId: 'u1' };

async function accepted(h: ReturnType<typeof harness>): Promise<string> {
  const answer = await h.svc.request(REQ);
  if (answer.status !== 'accepted') throw new Error(`expected accepted, got ${answer.status}`);
  return answer.jobId;
}

describe('AlbumGetService', () => {
  it('reserves the job at once, then finds and enqueues on its own', async () => {
    const h = harness([FOUND]);
    const jobId = await accepted(h);
    expect(h.rows()).toEqual([
      { id: jobId, state: 'active', stage: 'resolving', error: null, source_ref: null },
    ]);

    await h.svc.settled(jobId);
    expect(h.rows()).toEqual([
      {
        id: jobId,
        state: 'active',
        stage: 'queued',
        error: null,
        source_ref: 'addon:fixture-addon:aj-1',
      },
    ]);
  });

  it('answers already-downloading for a second click on the same album', async () => {
    const h = harness([FOUND]);
    const jobId = await accepted(h);
    expect(await h.svc.request(REQ)).toEqual({ status: 'already-downloading', jobId });
    await h.svc.settled(jobId);
    expect(h.calls().searchCalls).toBe(1);
  });

  it('answers no-addon without reserving anything', async () => {
    const h = harness([FOUND], { addon: false });
    expect(await h.svc.request(REQ)).toEqual({ status: 'no-addon' });
    expect(h.rows()).toEqual([]);
  });

  it('closes the job with a reason when nothing confident is found', async () => {
    const h = harness([NOTHING]);
    const jobId = await accepted(h);
    await h.svc.settled(jobId);
    const [row] = h.rows();
    expect(row).toMatchObject({ state: 'failed', stage: 'error' });
    expect(row!.error).toContain('No confident match');
    expect(h.timers).toHaveLength(0);
  });

  it('asks an offline source again later instead of failing the job', async () => {
    const h = harness([OFFLINE, FOUND]);
    const jobId = await accepted(h);
    await h.svc.settled(jobId);
    expect(h.rows()[0]).toMatchObject({ state: 'active', stage: 'resolving' });
    expect(h.timers.map((t) => t.ms)).toEqual([albumGetRetryDelayMs(1)!]);

    h.timers[0]!.fn();
    await h.svc.settled(jobId);
    expect(h.rows()[0]).toMatchObject({ state: 'active', stage: 'queued' });
    expect(h.calls()).toEqual({ searchCalls: 2, jobCalls: 1 });
  });

  it('gives up with the source reason once the retries run out', async () => {
    const h = harness([OFFLINE]);
    const jobId = await accepted(h);
    await h.svc.settled(jobId);
    while (h.timers.length) {
      h.timers.shift()!.fn();
      await h.svc.settled(jobId);
    }
    const [row] = h.rows();
    expect(row).toMatchObject({ state: 'failed', stage: 'error' });
    expect(row!.error).toContain('Source offline');
  });

  it('does not retry a job cancelled while it waited', async () => {
    const h = harness([OFFLINE, FOUND]);
    const jobId = await accepted(h);
    await h.svc.settled(jobId);
    cancelUnownedJob(h.db, jobId);
    h.timers[0]!.fn();
    await h.svc.settled(jobId);
    expect(h.calls()).toEqual({ searchCalls: 1, jobCalls: 0 });
    expect(h.rows()[0]).toMatchObject({ state: 'failed', error: 'Cancelled by user' });
  });

  it('resumes a reservation a restart interrupted', async () => {
    const h = harness([FOUND]);
    h.db.run(
      `INSERT INTO acquisition_jobs
         (id, kind, method, state, stage, artist_name, album_title, lidarr_album_id, created_at, updated_at)
       VALUES ('left-over', 'album-hunt', 'fixture-addon', 'active', 'resolving', 'Artist', 'Album', 42, 1, 1)`,
    );
    expect(h.svc.resumePending()).toBe(1);
    await h.svc.settled('left-over');
    expect(h.rows()[0]).toMatchObject({ id: 'left-over', stage: 'queued' });
  });

  it('is what POST /albums/:id/get answers from', async () => {
    const h = harness([FOUND]);
    const app = new Hono<AuthEnv>();
    app.use('*', (c, next) => {
      c.set('user', { sub: 'u', role: 'admin', iat: 0, exp: 9999999999 });
      return next();
    });
    app.route(
      '/',
      discographyRoutes({
        discography: {} as DiscographyService,
        provisioning: {} as ArtistProvisioningService,
        sourceHunt: {} as AlbumHuntOrchestrator,
        lidarr: h.lidarr,
        db: h.db,
        getAddon: () => h.addon,
        albumGet: h.svc,
      }),
    );
    const post = () => app.request('/albums/42/get', { method: 'POST' });

    const first = await post();
    expect(first.status).toBe(202);
    const { jobId } = (await first.json()) as { jobId: string };
    expect(h.rows()[0]!.id).toBe(jobId);

    const second = await post();
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'already-downloading', jobId });
  });
});
