/**
 * Issue #644 over HTTP: the discography GET is read-only, and the add is an
 * explicit POST that runs as a background job with a pollable status.
 */
import { describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import type { AuthEnv } from '../middleware/auth.js';
import { discographyRoutes } from './discography.js';
import { DiscographyService } from '../services/discography.service.js';
import { ArtistProvisioningService } from '../services/artist-provisioning.service.js';
import type { AlbumHuntOrchestrator } from '../services/source-hunter.js';
import type { Lidarr, LidarrArtist } from '../lidarr/index.js';

const hit: LidarrArtist = {
  id: 0,
  foreignArtistId: 'mbid-arjona',
  artistName: 'Arjona',
  sortName: 'Arjona',
  status: 'continuing',
  images: [],
  monitored: false,
};

/** `gateAt` picks which Lidarr call waits for `release()`. */
function setup(gateAt: 'add' | 'lookup' = 'add') {
  const db = new Database(':memory:');
  applySchema(db);
  db.run(
    `INSERT INTO library_artists (id, name, album_count, hidden, manual_override, synced_at)
     VALUES ('ar1', 'Arjona', 0, 0, 0, ?)`,
    [Date.now()],
  );
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const monitored: LidarrArtist[] = [];
  const add = mock(async (a: LidarrArtist) => {
    if (gateAt === 'add') await gate;
    const added = { ...a, id: 9 };
    monitored.push(added);
    return added;
  });
  const lidarr = {
    artist: {
      list: mock(async () => monitored),
      lookup: mock(async () => {
        if (gateAt === 'lookup') await gate;
        return [hit];
      }),
      add,
      getQualityProfiles: mock(async () => [{ id: 1, name: 'Any' }]),
      getMetadataProfiles: mock(async () => [{ id: 1, name: 'Standard' }]),
      getRootFolders: mock(async () => [{ id: 1, path: '/music', freeSpace: 0 }]),
    },
    album: { listByArtist: mock(async () => []) },
    track: { listByAlbum: mock(async () => []) },
  } as unknown as Lidarr;
  const provisioning = new ArtistProvisioningService({ lidarr, db });
  const app = new Hono<AuthEnv>();
  app.use('*', (c, next) => {
    c.set('user', { sub: 'u', username: 'kevin', role: 'admin', iat: 0, exp: 9999999999 });
    return next();
  });
  app.route(
    '/',
    discographyRoutes({
      discography: new DiscographyService(lidarr, db),
      provisioning,
      getAddon: () => null,
      sourceHunt: {
        hunt: async () => [],
        enabledSourceIds: () => [],
      } as unknown as AlbumHuntOrchestrator,
      lidarr,
      db,
    }),
  );
  const idle = () =>
    new Promise<void>((resolve) => {
      const on = (s: { phase: string }) => {
        if (s.phase !== 'idle') return;
        provisioning.off('status', on);
        resolve();
      };
      provisioning.on('status', on);
    });
  return { app, add, release, idle };
}

describe('discography provisioning routes (#644)', () => {
  it('GET answers not-provisioned without adding; POST adds as a job; GET then serves', async () => {
    const { app, add, release, idle } = setup();

    const before = await app.request('/artists/ar1');
    expect(before.status).toBe(200);
    expect(await before.json()).toMatchObject({
      notProvisioned: true,
      artistId: 'ar1',
      provisioning: false,
    });
    expect(add).not.toHaveBeenCalled();

    const done = idle();
    const started = await app.request('/artists/ar1/provision', { method: 'POST' });
    expect(started.status).toBe(202);
    expect(await started.json()).toMatchObject({
      provisioning: true,
      status: { phase: 'running', startedBy: 'kevin', target: { localArtistId: 'ar1' } },
    });

    const pending = await app.request('/artists/ar1');
    expect(await pending.json()).toMatchObject({ notProvisioned: true, provisioning: true });

    release();
    await done;
    const status = await (await app.request('/provisioning')).json();
    expect(status).toMatchObject({ phase: 'idle', lastOutcome: 'completed', lidarrId: 9 });

    const after = await app.request('/artists/ar1');
    expect(await after.json()).toMatchObject({ artistId: 'ar1', lidarrId: 9, albums: [] });
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('POST provision 404s for an unknown artist', async () => {
    const res = await setup().app.request('/artists/nope/provision', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('POST provisioning/cancel stops a running job before its add', async () => {
    const { app, add, release, idle } = setup('lookup');
    const done = idle();
    await app.request('/artists/ar1/provision', { method: 'POST' });
    const res = await app.request('/provisioning/cancel', { method: 'POST' });
    expect(await res.json()).toEqual({ ok: true });
    release();
    await done;
    expect(add).not.toHaveBeenCalled();
    expect(await (await app.request('/provisioning')).json()).toMatchObject({
      lastOutcome: 'cancelled',
    });
  });
});
