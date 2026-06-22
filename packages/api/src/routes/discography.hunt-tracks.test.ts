import { describe, it, expect, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import type { AuthEnv } from '../middleware/auth.js';
import { discographyRoutes } from './discography.js';
import type { DiscographyService } from '../services/discography.service.js';
import type { AlbumHunterService } from '../services/album-hunter.service.js';
import type { AlbumHuntOrchestrator } from '../services/source-hunter.js';
import type { Lidarr } from '@nicotind/lidarr-client';
import type { SlskdRef } from '../index.js';

const noopSourceHunt = {
  hunt: async () => [],
  enabledSourceIds: () => [],
} as unknown as AlbumHuntOrchestrator;

const mockLidarr = () =>
  ({
    album: { get: mock(async () => ({ id: 1, title: 'So Good', artist: { artistName: 'Zara Larsson' } })) },
    track: {
      listByAlbum: mock(async () => [
        { title: 'Lush Life' },
        { title: 'Never Forget You' },
      ]),
    },
  }) as unknown as Lidarr;

const mockSlskd = () =>
  ({
    searches: {
      create: mock(async () => ({ id: 's1' })),
      get: mock(async () => ({ state: 'Completed' })),
      getResponses: mock(async () => [
        { username: 'p', freeUploadSlots: 1, files: [{ filename: 'x\\Lush Life.flac', size: 1 }] },
      ]),
      delete: mock(async () => {}),
    },
    transfers: { enqueue: mock(async () => {}) },
  }) as unknown as SlskdRef['current'];

function makeApp(lidarr: Lidarr, slskdRef: SlskdRef): Hono<AuthEnv> {
  const db = new Database(':memory:');
  applySchema(db);
  const app = new Hono<AuthEnv>();
  app.use('*', (c, next) => {
    c.set('user', { sub: 'u', role: 'admin', iat: 0, exp: 9999999999 });
    return next();
  });
  app.route(
    '/',
    discographyRoutes({
      discography: {} as DiscographyService,
      hunter: {} as AlbumHunterService,
      sourceHunt: noopSourceHunt,
      lidarr,
      db,
      slskdRef,
    }),
  );
  return app;
}

const post = (app: Hono<AuthEnv>, body: unknown) =>
  app.request('/albums/1/hunt-tracks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /albums/:id/hunt-tracks', () => {
  it('resolves the tracklist from Lidarr and enqueues matched tracks', async () => {
    const app = makeApp(mockLidarr(), { current: mockSlskd() } as SlskdRef);
    const res = await post(app, { artistName: 'Zara Larsson' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { requested: number; enqueued: number; misses: string[] };
    expect(body.requested).toBe(2);
    // "Lush Life" matches; "Never Forget You" has no peer → a miss.
    expect(body.enqueued).toBe(1);
    expect(body.misses).toEqual(['Never Forget You']);
  });

  it('503s when Soulseek is unavailable', async () => {
    const app = makeApp(mockLidarr(), { current: null } as SlskdRef);
    expect((await post(app, {})).status).toBe(503);
  });

  it('404s when the album has no tracks', async () => {
    const lidarr = {
      album: { get: mock(async () => ({ id: 1, title: 'X', artist: { artistName: 'A' } })) },
      track: { listByAlbum: mock(async () => []) },
    } as unknown as Lidarr;
    const app = makeApp(lidarr, { current: mockSlskd() } as SlskdRef);
    expect((await post(app, {})).status).toBe(404);
  });
});
