import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Hono } from 'hono';
import { ADDON_PROTOCOL_VERSION, type AddonJobRequest, type AddonManifest } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { applySchema } from '../db.js';
import { RemoteAddonPlugin } from './addons/remote-addon-plugin.js';
import { AddonRequestError, type AddonClient } from './addons/client.js';
import { requestJobCancel } from './acquisition-job-store.js';
import { TrackGetService } from './track-get.service.js';
import { trackGetRoutes } from '../routes/track-get.js';

const MANIFEST: AddonManifest = {
  id: 'fixture-addon',
  name: 'Fixture',
  description: 'x',
  version: '0.1.0',
  protocolVersion: ADDON_PROTOCOL_VERSION,
  kind: 'acquisition',
  capabilities: ['search', 'download'],
};

type JobRow = {
  id: string;
  kind: string;
  state: string;
  stage: string;
  error: string | null;
  source_ref: string | null;
  artist_name: string | null;
  album_title: string | null;
};

function harness(
  opts: { createJob?: (req: AddonJobRequest) => Promise<unknown>; addon?: boolean } = {},
) {
  const db = new Database(':memory:');
  applySchema(db);
  const asked: AddonJobRequest[] = [];
  const cancelled: string[] = [];
  const client = {
    baseUrl: 'http://addon:9999',
    createJob: async (req: AddonJobRequest) => {
      asked.push(req);
      return opts.createJob
        ? opts.createJob(req)
        : { id: 'aj-1', intent: 'tracks', items: [], createdAt: 1 };
    },
    cancelJob: async (id: string) => {
      cancelled.push(id);
    },
  } as unknown as AddonClient;
  const addon = new RemoteAddonPlugin(MANIFEST, client);
  const svc = new TrackGetService({ db, getAddon: () => (opts.addon === false ? null : addon) });
  const row = (id: string) =>
    db
      .query<JobRow, [string]>(
        'SELECT id, kind, state, stage, error, source_ref, artist_name, album_title FROM acquisition_jobs WHERE id = ?',
      )
      .get(id)!;
  return { db, svc, asked, cancelled, row };
}

describe('TrackGetService', () => {
  it('reserves the job before the source is asked, then hands it the track', async () => {
    const { svc, asked, row } = harness();
    const answer = svc.request({
      artist: 'Ennio Morricone',
      title: "L'estasi dell'oro",
      userId: 'u',
    });
    expect(answer.status).toBe('accepted');
    const jobId = (answer as { jobId: string }).jobId;
    expect(row(jobId)).toMatchObject({ kind: 'track-search', state: 'active', stage: 'resolving' });

    await svc.settled(jobId);
    expect(asked).toEqual([
      { intent: 'tracks', artist: 'Ennio Morricone', titles: ["L'estasi dell'oro"] },
    ]);
    expect(row(jobId)).toMatchObject({
      stage: 'queued',
      source_ref: 'addon:fixture-addon:aj-1',
    });
  });

  it('files by the album the surface saw the track on', async () => {
    const { svc, asked, row } = harness();
    const { jobId } = svc.request({
      artist: 'A',
      title: 'T',
      album: 'The Album',
      userId: null,
    }) as { jobId: string };
    await svc.settled(jobId);
    expect(asked[0]?.album).toBe('The Album');
    expect(row(jobId).album_title).toBe('The Album');
  });

  it('a song no peer has closes the job with that reason, not a fault', async () => {
    const { svc, row } = harness({
      createJob: async () => {
        throw new AddonRequestError('addon responded 400', 400, 'no tracks found (1 misses)');
      },
    });
    const { jobId } = svc.request({ artist: 'A', title: 'Rare', userId: null }) as {
      jobId: string;
    };
    await svc.settled(jobId);
    expect(row(jobId)).toMatchObject({
      state: 'failed',
      stage: 'error',
      error: 'No copy of "Rare" was found.',
    });
  });

  it('a source fault keeps its own message', async () => {
    const { svc, row } = harness({
      createJob: async () => {
        throw new Error('addon unreachable');
      },
    });
    const { jobId } = svc.request({ artist: 'A', title: 'T', userId: null }) as { jobId: string };
    await svc.settled(jobId);
    expect(row(jobId).error).toContain('addon unreachable');
  });

  it('a Get cancelled while the source searched stops what the source started', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { db, svc, cancelled, row } = harness({
      createJob: async () => {
        await gate;
        return { id: 'aj-9', intent: 'tracks', items: [], createdAt: 1 };
      },
    });
    const { jobId } = svc.request({ artist: 'A', title: 'T', userId: null }) as { jobId: string };
    await Promise.resolve();
    requestJobCancel(db, jobId);
    release();
    await svc.settled(jobId);
    expect(cancelled).toEqual(['aj-9']);
    expect(row(jobId).source_ref).toBeNull();
  });

  it('answers no-addon without reserving anything', () => {
    const { db, svc } = harness({ addon: false });
    expect(svc.request({ artist: 'A', title: 'T', userId: null })).toEqual({ status: 'no-addon' });
    expect(db.query('SELECT COUNT(*) AS n FROM acquisition_jobs').get()).toEqual({ n: 0 });
  });

  it('a restart resumes a track Get its source was never asked for', async () => {
    const first = harness({ createJob: () => new Promise(() => {}) });
    const { jobId } = first.svc.request({ artist: 'A', title: 'T', userId: null }) as {
      jobId: string;
    };
    const asked: AddonJobRequest[] = [];
    const client = {
      baseUrl: 'http://addon:9999',
      createJob: async (req: AddonJobRequest) => {
        asked.push(req);
        return { id: 'aj-2', intent: 'tracks', items: [], createdAt: 1 };
      },
    } as unknown as AddonClient;
    const after = new TrackGetService({
      db: first.db,
      getAddon: () => new RemoteAddonPlugin(MANIFEST, client),
    });
    expect(after.resumePending()).toBe(1);
    await after.settled(jobId);
    expect(asked[0]?.titles).toEqual(['T']);
    expect(first.row(jobId).source_ref).toBe('addon:fixture-addon:aj-2');
  });
});

describe('POST /track', () => {
  const app = (svc: TrackGetService, role = 'user') => {
    const a = new Hono<AuthEnv>();
    a.use('*', (c, next) => {
      c.set('user', { sub: 'u1', username: 'k', role, iat: 0, exp: 9_999_999_999 } as never);
      return next();
    });
    a.route('/', trackGetRoutes(svc));
    return a;
  };
  const post = (a: Hono<AuthEnv>, body: unknown) =>
    a.request('/track', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('answers 202 with the reserved job', async () => {
    const { svc } = harness();
    const res = await post(app(svc), { artist: 'A', title: 'T' });
    expect(res.status).toBe(202);
    expect(((await res.json()) as { jobId: string }).jobId).toBeString();
  });

  it('400s without an artist and a title', async () => {
    const { svc } = harness();
    expect((await post(app(svc), { title: 'T' })).status).toBe(400);
  });

  it('503s with no source', async () => {
    const { svc } = harness({ addon: false });
    expect((await post(app(svc), { artist: 'A', title: 'T' })).status).toBe(503);
  });

  it('is for acquirers only', async () => {
    const { svc } = harness();
    expect((await post(app(svc, 'listener'), { artist: 'A', title: 'T' })).status).toBe(403);
  });
});
