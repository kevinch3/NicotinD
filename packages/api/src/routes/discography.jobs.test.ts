import { describe, it, expect, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import type { AuthEnv } from '../middleware/auth.js';
import { discographyRoutes } from './discography.js';
import type { DiscographyService } from '../services/discography.service.js';
import type { AlbumHuntOrchestrator } from '../services/source-hunter.js';
import type { Lidarr } from '@nicotind/lidarr-client';

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
      getAddon: () => null,
      sourceHunt: noopSourceHunt,
      lidarr: {} as Lidarr,
      db,
    }),
  );
  return app;
}

function record(db: Database, albumTitle: string, state: string) {
  // Seed an album_jobs row directly (was AlbumFallbackService.recordJob before
  // api dropped its @nicotind/slskd-addon dependency — the addon owns that
  // service now; this mirrors its INSERT).
  db.run(
    `INSERT INTO album_jobs
       (lidarr_album_id, username, directory, artist_name, album_title, canonical_tracks_json, target_files_json, alternates_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      1,
      'p',
      'D',
      'Soda Stereo',
      albumTitle,
      JSON.stringify(['x']),
      null,
      JSON.stringify([]),
      Date.now(),
    ],
  );
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
