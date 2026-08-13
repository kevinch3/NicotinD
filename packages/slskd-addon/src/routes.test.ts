import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Slskd } from '@nicotind/slskd-client';
import type { AddonAlbumSearchResponse, AddonJob } from '@nicotind/addon-sdk';
import { applySchema } from './db.js';
import { createAddonApp } from './server.js';
import { AlbumHunterService } from './services/album-hunter.service.js';
import { TrackHunterService } from './services/track-hunter.service.js';
import { TransferPoller } from './services/transfer-poller.js';
import { markItemsCompletedByTransfer } from './services/job-store.js';

const AUTH = { Authorization: 'Bearer tok' };
const json = (body: unknown) => ({
  method: 'POST',
  headers: { ...AUTH, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * A canned slskd covering the whole engine loop: one search returning a
 * 2-track folder from peer "goodpeer", enqueue capture, transfer states.
 */
function stubSlskd(state: {
  enqueued: Array<{ username: string; files: unknown[] }>;
  downloads: unknown[];
}): Slskd {
  return {
    searches: {
      create: async () => ({ id: 's1', state: 'Completed' }),
      get: async () => ({ id: 's1', state: 'Completed' }),
      getResponses: async () => [
        {
          username: 'goodpeer',
          freeUploadSlots: 1,
          queueLength: 0,
          uploadSpeed: 100,
          files: [
            { filename: 'Music\\Album\\01 Song One.mp3', size: 1000, bitRate: 320 },
            { filename: 'Music\\Album\\02 Song Two.mp3', size: 2000, bitRate: 320 },
          ],
        },
      ],
      delete: async () => {},
    },
    transfers: {
      enqueue: async (username: string, files: unknown[]) => {
        state.enqueued.push({ username, files });
      },
      getDownloads: async () => state.downloads,
      cancel: async () => {},
    },
    server: { getState: async () => ({ isConnected: true }) },
    users: {
      browseUser: async (username: string) => [
        { directory: `${username}\\Music`, fileCount: 1, files: [] },
      ],
    },
    shares: { rescan: async () => {} },
  } as unknown as Slskd;
}

function makeHarness() {
  const db = new Database(':memory:');
  applySchema(db);
  const state = {
    enqueued: [] as Array<{ username: string; files: unknown[] }>,
    downloads: [] as unknown[],
  };
  const slskd = stubSlskd(state);
  const slskdRef = { current: slskd };
  const downloadsDir = mkdtempSync(join(tmpdir(), 'addon-dl-'));
  const app = createAddonApp({
    db,
    slskdRef,
    token: 'tok',
    engine: {
      hunter: () => new AlbumHunterService(slskdRef.current),
      trackHunter: () => new TrackHunterService(slskdRef.current),
      downloadsDir: () => downloadsDir,
    },
  });
  return { app, db, state, downloadsDir, slskdRef };
}

describe('addon protocol routes', () => {
  let h: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    h = makeHarness();
  });

  it('albums/search returns ranked candidates with refs + queries', async () => {
    const res = await h.app.request(
      '/addon/v1/albums/search',
      json({
        artist: 'Artist',
        album: 'Album',
        canonicalTracks: [{ title: 'Song One' }, { title: 'Song Two' }],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AddonAlbumSearchResponse;
    expect(body.candidates.length).toBeGreaterThan(0);
    expect(body.candidates[0]!.matchPct).toBe(100);
    expect(body.candidates[0]!.candidateRef).toBeTruthy();
    expect(body.queries.length).toBeGreaterThan(0);
  });

  it('runs the album job loop: candidateRef → enqueue → items → completion → file fetch', async () => {
    const search = await h.app.request(
      '/addon/v1/albums/search',
      json({
        artist: 'Artist',
        album: 'Album',
        canonicalTracks: [{ title: 'Song One' }, { title: 'Song Two' }],
      }),
    );
    const { candidates } = (await search.json()) as AddonAlbumSearchResponse;

    const created = await h.app.request(
      '/addon/v1/jobs',
      json({
        intent: 'album',
        artist: 'Artist',
        album: 'Album',
        canonicalTracks: [{ title: 'Song One' }, { title: 'Song Two' }],
        wantedTracks: [{ title: 'Song One' }],
        candidateRef: candidates[0]!.candidateRef,
      }),
    );
    expect(created.status).toBe(201);
    const { job } = (await created.json()) as { job: AddonJob };
    // Wanted scoping: only Song One enqueued.
    expect(h.state.enqueued).toHaveLength(1);
    expect(h.state.enqueued[0]!.files).toHaveLength(1);
    expect(job.items).toHaveLength(1);
    expect(job.items[0]!.itemId).toBe('t:song one');
    expect(job.state).toBe('active');

    // A duplicate album job 409s with the existing id.
    const dup = await h.app.request(
      '/addon/v1/jobs',
      json({ intent: 'album', artist: 'Artist', album: 'Album', canonicalTracks: [] }),
    );
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { existingJobId: string }).existingJobId).toBe(job.id);

    // Simulate the transfer completing on disk, then the poller noticing.
    mkdirSync(join(h.downloadsDir, 'Album'), { recursive: true });
    writeFileSync(join(h.downloadsDir, 'Album', '01 Song One.mp3'), 'audio-bytes');
    h.state.downloads = [
      {
        username: 'goodpeer',
        directories: [
          {
            directory: 'Music\\Album',
            fileCount: 1,
            files: [
              {
                id: 'tr1',
                filename: 'Music\\Album\\01 Song One.mp3',
                size: 11,
                state: 'Completed, Succeeded',
              },
            ],
          },
        ],
      },
    ];
    const poller = new TransferPoller(h.slskdRef.current, {
      db: h.db,
      rootDir: h.downloadsDir,
      onCompleted: (files) =>
        markItemsCompletedByTransfer(
          h.db,
          files.map((f) => ({
            username: f.username,
            filename: f.filename,
            fileReady: f.relativePath !== null,
          })),
        ),
    });
    await poller.check();

    const after = await h.app.request(`/addon/v1/jobs/${job.id}`, { headers: AUTH });
    const refreshed = ((await after.json()) as { job: AddonJob }).job;
    expect(refreshed.state).toBe('done');
    expect(refreshed.items[0]!.fileReady).toBe(true);

    const file = await h.app.request(`/addon/v1/jobs/${job.id}/files/t:song one`, {
      headers: AUTH,
    });
    expect(file.status).toBe(200);
    expect(await file.text()).toBe('audio-bytes');
    expect(file.headers.get('etag')).toBeTruthy();
  });

  it('search returns song + folder rows', async () => {
    const res = await h.app.request('/addon/v1/search', json({ query: 'artist album', waitMs: 1 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ kind: string }>; complete: boolean };
    expect(body.results.some((r) => r.kind === 'song')).toBe(true);
    expect(body.results.some((r) => r.kind === 'folder')).toBe(true);
  });

  it('browse-grab enqueues explicit files; cancel resolves the job', async () => {
    const created = await h.app.request(
      '/addon/v1/jobs',
      json({
        intent: 'browse-grab',
        username: 'goodpeer',
        files: [{ filename: 'Music\\Loose\\Track.mp3', size: 5 }],
      }),
    );
    expect(created.status).toBe(201);
    const { job } = (await created.json()) as { job: AddonJob };
    expect(h.state.enqueued).toHaveLength(1);

    const cancelled = await h.app.request(`/addon/v1/jobs/${job.id}/cancel`, {
      method: 'POST',
      headers: AUTH,
    });
    const body = ((await cancelled.json()) as { job: AddonJob }).job;
    expect(body.state).toBe('cancelled');
    expect(body.items[0]!.state).toBe('failed');
  });

  it('browse proxies the peer listing and notify debounces a rescan', async () => {
    const browse = await h.app.request('/addon/v1/browse?user=goodpeer', { headers: AUTH });
    expect(browse.status).toBe(200);
    const { directories } = (await browse.json()) as { directories: unknown[] };
    expect(directories).toHaveLength(1);

    const notify = await h.app.request('/addon/v1/notify/library-changed', {
      method: 'POST',
      headers: AUTH,
    });
    expect(notify.status).toBe(200);
  });

  it('idempotency key replays the same job', async () => {
    const req = () =>
      h.app.request('/addon/v1/jobs', {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json', 'Idempotency-Key': 'k1' },
        body: JSON.stringify({
          intent: 'browse-grab',
          username: 'goodpeer',
          files: [{ filename: 'Music\\Loose\\Track.mp3', size: 5 }],
        }),
      });
    const first = ((await (await req()).json()) as { job: AddonJob }).job;
    const second = ((await (await req()).json()) as { job: AddonJob }).job;
    expect(second.id).toBe(first.id);
    expect(h.state.enqueued).toHaveLength(1);
  });
});
