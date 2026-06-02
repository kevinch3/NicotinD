import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import type { AuthEnv } from '../middleware/auth.js';
import { discographyRoutes } from './discography.js';
import type { DiscographyService } from '../services/discography.service.js';
import type { AlbumHunterService } from '../services/album-hunter.service.js';
import type { Lidarr } from '@nicotind/lidarr-client';
import type { SlskdRef } from '../index.js';

const ALBUM_ID = 42;
const TRACKS = [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }];

function makeApp(db: Database) {
  const enqueue = mock(async () => undefined);
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
      hunter: {} as AlbumHunterService,
      lidarr,
      db,
      slskdRef: { current: { transfers: { enqueue } } } as unknown as SlskdRef,
    }),
  );
  return { app, enqueue };
}

const BODY = {
  selected: { username: 'peer', directory: 'Soda Stereo - Dynamo', files: [{ filename: '01 One.flac', size: 1 }] },
  alternates: [],
};

function post(app: Hono<AuthEnv>, query = '') {
  return app.request(`/albums/${ALBUM_ID}/hunt-download${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(BODY),
  });
}

function activeJobCount(db: Database): number {
  return (
    db.query(`SELECT count(*) c FROM album_jobs WHERE lidarr_album_id = ? AND state = 'active'`).get(ALBUM_ID) as {
      c: number;
    }
  ).c;
}

describe('POST /albums/:id/hunt-download idempotency guard', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
  });

  it('records a job and enqueues on the first download', async () => {
    const { app, enqueue } = makeApp(db);
    const res = await post(app);
    expect(res.status).toBe(201);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(activeJobCount(db)).toBe(1);
  });

  it('rejects a second download while one is already in flight (409, no second job)', async () => {
    const { app, enqueue } = makeApp(db);
    await post(app);
    enqueue.mockClear();

    const res = await post(app);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('already-downloading');
    expect(enqueue).not.toHaveBeenCalled();
    expect(activeJobCount(db)).toBe(1); // still exactly one
  });

  it('replace=true supersedes the prior active job and starts a new one', async () => {
    const { app, enqueue } = makeApp(db);
    await post(app);
    enqueue.mockClear();

    const res = await post(app, '?replace=true');
    expect(res.status).toBe(201);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(activeJobCount(db)).toBe(1); // old superseded, one new active
    const superseded = db
      .query(`SELECT count(*) c FROM album_jobs WHERE state = 'superseded'`)
      .get() as { c: number };
    expect(superseded.c).toBe(1);
  });

  it('rejects when the album is already complete in the library (409)', async () => {
    const { app, enqueue } = makeApp(db);
    // Seed a library album with the same artist+title and >= canonical track count.
    db.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, synced_at)
       VALUES ('alb1', 'Dynamo', 'Soda Stereo', 'art1', ?, 1)`,
      [TRACKS.length],
    );
    const res = await post(app);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('already-complete');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('treats an edition variant in the library as already complete', async () => {
    const { app, enqueue } = makeApp(db);
    db.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, synced_at)
       VALUES ('alb1', 'Dynamo (Deluxe Edition)', 'Soda Stereo', 'art1', ?, 1)`,
      [TRACKS.length],
    );
    const res = await post(app);
    expect(res.status).toBe(409);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
