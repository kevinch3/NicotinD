import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { ADDON_PROTOCOL_VERSION, type AddonManifest } from '@nicotind/core';
import { applySchema } from '../db.js';
import type { AuthEnv } from '../middleware/auth.js';
import { discographyRoutes } from './discography.js';
import type { DiscographyService } from '../services/discography.service.js';
import type { AlbumHuntOrchestrator } from '../services/source-hunter.js';
import type { Lidarr } from '@nicotind/lidarr-client';
import { RemoteAddonPlugin } from '../services/addons/remote-addon-plugin.js';
import { AddonRequestError, type AddonClient } from '../services/addons/client.js';

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
  directory: 'Soda Stereo - Dynamo',
  matchedTracks: 3,
  totalTracks: 3,
  matchPct: 100,
  format: 'FLAC',
  estimatedSizeMb: 200,
  isLive: false,
  files: [{ filename: '01 One.flac', size: 1, bitRateKbps: 900 }],
  freeUploadSlots: 2,
  queueLength: 0,
  uploadSpeed: 5000,
};

const TRACKS = [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }];

function harness(clientOver: Partial<AddonClient> = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const jobRequests: unknown[] = [];
  const client = {
    baseUrl: 'http://addon:9999',
    albumsSearch: mock(async () => ({
      candidates: [CANDIDATE],
      queries: ['q1'],
      skewNeeded: true,
    })),
    createJob: mock(async (req: unknown) => {
      jobRequests.push(req);
      return {
        id: 'aj-1',
        intent: 'album',
        items: [
          {
            itemId: 't:one',
            title: 'One',
            username: 'peer',
            filename: '01 One.flac',
            size: 1,
            state: 'queued',
            fileReady: false,
            updatedAt: 1,
          },
        ],
      };
    }),
    listJobs: mock(async () => []),
    cancelJob: mock(async () => {}),
    deleteJob: mock(async () => {}),
    ...clientOver,
  } as unknown as AddonClient;
  const addon = new RemoteAddonPlugin(MANIFEST, client);

  const lidarr = {
    album: { get: mock(async () => ({ title: 'Dynamo', artist: { artistName: 'Soda Stereo' } })) },
    track: { listByAlbum: mock(async () => TRACKS) },
  } as unknown as Lidarr;

  const app = new Hono<AuthEnv>();
  app.use('*', (c, next) => {
    c.set('user', { sub: 'u', role: 'admin', iat: 0, exp: 9999999999 });
    return next();
  });
  app.route(
    '/',
    discographyRoutes({
      discography: {} as DiscographyService,
      sourceHunt: {
        hunt: async () => [],
        enabledSourceIds: () => [],
      } as unknown as AlbumHuntOrchestrator,
      lidarr,
      db,
      getAddon: () => addon,
    }),
  );
  return { app, db, jobRequests };
}

const jsonPost = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('discography routes through a remote addon', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
  });

  it('hunt/base maps addon candidates to the modal wire shape (no second skew phase)', async () => {
    const res = await h.app.request('/albums/42/hunt/base', jsonPost({}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      candidates: Array<{
        candidateRef?: string;
        matchPct: number;
        files: Array<{ bitRate?: number }>;
      }>;
      skewNeeded: boolean;
      totalTracks: number;
    };
    expect(body.skewNeeded).toBe(false);
    expect(body.totalTracks).toBe(3);
    expect(body.candidates[0]!.candidateRef).toBe('ref-1');
    expect(body.candidates[0]!.files[0]!.bitRate).toBe(900);
  });

  it('hunt-download acquires the exact pick and records the mapped feed row', async () => {
    const res = await h.app.request(
      '/albums/42/hunt-download',
      jsonPost({
        selected: {
          username: 'peer',
          directory: 'Soda Stereo - Dynamo',
          files: [{ filename: '01 One.flac', size: 1 }],
          candidateRef: 'ref-1',
        },
        alternates: [],
      }),
    );
    expect(res.status).toBe(201);
    expect(h.jobRequests[0]).toMatchObject({
      intent: 'album',
      candidateRef: 'ref-1',
      wantedTracks: [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }],
    });
    const job = h.db
      .query<{ method: string; kind: string; source_ref: string }, []>(
        `SELECT * FROM acquisition_jobs`,
      )
      .get()!;
    expect(job.method).toBe('fixture-addon');
    expect(job.kind).toBe('album-hunt');
    expect(job.source_ref).toBe('addon:fixture-addon:aj-1');
  });

  it('hunt-download without a candidateRef is a stale selection', async () => {
    const res = await h.app.request(
      '/albums/42/hunt-download',
      jsonPost({
        selected: { username: 'peer', directory: 'd', files: [{ filename: 'f', size: 1 }] },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('maps the addon 409 to already-downloading', async () => {
    h = harness({
      createJob: mock(async () => {
        throw new AddonRequestError('conflict', 409);
      }) as unknown as AddonClient['createJob'],
    });
    const res = await h.app.request(
      '/albums/42/hunt-download',
      jsonPost({
        selected: {
          username: 'peer',
          directory: 'd',
          files: [{ filename: 'f', size: 1 }],
          candidateRef: 'ref-1',
        },
      }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('already-downloading');
  });

  // Issue #531: the 502 body used to be only the "they may be offline" guess,
  // discarding the addon's actual reason — the toast (and the log) said nothing
  // actionable while every one-click download was failing (#530).
  it('hunt-download 502 carries the addon error detail', async () => {
    h = harness({
      createJob: mock(async () => {
        throw new AddonRequestError('slskd rejected the enqueue', 503);
      }) as unknown as AddonClient['createJob'],
    });
    const res = await h.app.request(
      '/albums/42/hunt-download',
      jsonPost({
        selected: {
          username: 'peer',
          directory: 'd',
          files: [{ filename: 'f', size: 1 }],
          candidateRef: 'ref-1',
        },
      }),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('peer');
    expect(body.error).toContain('slskd rejected the enqueue');
  });

  it('hunt-tracks runs addon-side and keeps the TrackHuntResult shape', async () => {
    const res = await h.app.request('/albums/42/hunt-tracks', jsonPost({}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      requested: number;
      enqueued: number;
      misses: string[];
      downloads: Array<{ title: string }>;
    };
    expect(body.requested).toBe(3);
    expect(body.enqueued).toBe(1);
    expect(body.misses).toEqual(['Two', 'Three']);
    expect(body.downloads[0]!.title).toBe('One');
    const job = h.db
      .query<{ kind: string; method: string }, []>(`SELECT * FROM acquisition_jobs`)
      .get()!;
    expect(job.kind).toBe('track-search');
    expect(job.method).toBe('fixture-addon');
  });
});
