import { describe, it, expect, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import type { AuthEnv } from '../middleware/auth.js';
import { discographyRoutes } from './discography.js';
import { AlbumFallbackService } from '../services/album-fallback.service.js';
import type { DiscographyService } from '../services/discography.service.js';
import type { AlbumHunterService } from '../services/album-hunter.service.js';
import type { AlbumHuntOrchestrator } from '../services/source-hunter.js';
import type { Lidarr } from '@nicotind/lidarr-client';
import type { SlskdRef } from '../index.js';

const noopSourceHunt = {
  hunt: async () => [],
  enabledSourceIds: () => [],
} as unknown as AlbumHuntOrchestrator;

function makeApp(db: Database): Hono<AuthEnv> {
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
      lidarr: {} as Lidarr,
      db,
      slskdRef: { current: null } as SlskdRef,
    }),
  );
  return app;
}

function record(db: Database, albumTitle: string, state: string) {
  AlbumFallbackService.recordJob(db, {
    lidarrAlbumId: 1,
    username: 'p',
    directory: 'D',
    artistName: 'Soda Stereo',
    albumTitle,
    canonicalTracks: ['x'],
    alternates: [],
  });
  db.run('UPDATE album_jobs SET state = ? WHERE album_title = ?', [state, albumTitle]);
}

describe('GET /jobs', () => {
  let db: Database;
  let app: Hono<AuthEnv>;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    app = makeApp(db);
    record(db, 'Cancion Animal', 'exhausted');
    record(db, 'Sueno Stereo', 'active');
    record(db, 'Dynamo', 'done');
  });

  it('returns only incomplete (exhausted + active) jobs by default', async () => {
    const res = await app.request('/jobs');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: Array<{ albumTitle: string; state: string }> };
    const titles = body.jobs.map((j) => j.albumTitle).sort();
    expect(titles).toEqual(['Cancion Animal', 'Sueno Stereo']);
    expect(body.jobs.every((j) => j.state !== 'done')).toBe(true);
  });

  it('filters to a specific state', async () => {
    const res = await app.request('/jobs?state=exhausted');
    const body = (await res.json()) as { jobs: Array<{ albumTitle: string; artistName: string }> };
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0].albumTitle).toBe('Cancion Animal');
    expect(body.jobs[0].artistName).toBe('Soda Stereo');
  });

  it('returns every job with state=all', async () => {
    const res = await app.request('/jobs?state=all');
    const body = (await res.json()) as { jobs: unknown[] };
    expect(body.jobs).toHaveLength(3);
  });
});
