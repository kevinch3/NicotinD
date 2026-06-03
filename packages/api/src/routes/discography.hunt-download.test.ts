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
import { albumIdFor, artistIdFor } from '../services/library-scanner.js';
import { resolveArtwork } from '../services/artwork-store.js';

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

  it('persists canonical album + artist artwork from the Lidarr payload', async () => {
    const enqueue = mock(async () => undefined);
    const lidarr = {
      album: {
        get: mock(async () => ({
          title: 'Dynamo',
          images: [{ coverType: 'cover', remoteUrl: 'https://art/dynamo.jpg' }],
          artist: {
            artistName: 'Soda Stereo',
            images: [{ coverType: 'poster', remoteUrl: 'https://art/soda.jpg' }],
          },
        })),
      },
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

    const res = await post(app);
    expect(res.status).toBe(201);
    expect(resolveArtwork(db, albumIdFor('Soda Stereo', 'Dynamo'))?.url).toBe(
      'https://art/dynamo.jpg',
    );
    expect(resolveArtwork(db, artistIdFor('Soda Stereo'))?.url).toBe('https://art/soda.jpg');
  });

  it('enqueues only the missing tracks when the album is partially on disk', async () => {
    const { app, enqueue } = makeApp(db);
    // 'One' is already on disk for this album (same grouping id).
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, path, synced_at)
       VALUES ('s1', ?, 'One', 'Soda Stereo', 'art', '/m/s1.flac', 1)`,
      [albumIdFor('Soda Stereo', 'Dynamo')],
    );

    const res = await app.request(`/albums/${ALBUM_ID}/hunt-download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        selected: {
          username: 'peer',
          directory: 'Soda Stereo - Dynamo',
          files: [
            { filename: '01 One.flac', size: 1 },
            { filename: '02 Two.flac', size: 1 },
            { filename: '03 Three.flac', size: 1 },
          ],
        },
        alternates: [],
      }),
    });

    expect(res.status).toBe(201);
    // Only the two missing tracks are enqueued — not 'One', which is on disk.
    const [, files] = enqueue.mock.calls[0] as unknown as [string, Array<{ filename: string }>];
    expect(files.map((f) => f.filename)).toEqual(['02 Two.flac', '03 Three.flac']);
    // The recorded job's recovery target is the missing set, not the full folder.
    const job = db
      .query(`SELECT target_files_json FROM album_jobs WHERE lidarr_album_id = ?`)
      .get(ALBUM_ID) as { target_files_json: string };
    expect(JSON.parse(job.target_files_json)).toEqual(['02 Two.flac', '03 Three.flac']);
  });

  it('downloads nothing (queued 0) when every chosen file is already on disk', async () => {
    const { app, enqueue } = makeApp(db);
    for (const [id, title] of [['s1', 'One'], ['s2', 'Two'], ['s3', 'Three']]) {
      db.run(
        `INSERT INTO library_songs (id, album_id, title, artist, artist_id, path, synced_at)
         VALUES (?, ?, ?, 'Soda Stereo', 'art', ?, 1)`,
        [id, albumIdFor('Soda Stereo', 'Dynamo'), title, `/m/${id}.flac`],
      );
    }

    const res = await app.request(`/albums/${ALBUM_ID}/hunt-download?replace=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        selected: {
          username: 'peer',
          directory: 'Soda Stereo - Dynamo',
          files: [
            { filename: '01 One.flac', size: 1 },
            { filename: '02 Two.flac', size: 1 },
            { filename: '03 Three.flac', size: 1 },
          ],
        },
        alternates: [],
      }),
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { alreadyComplete: boolean }).alreadyComplete).toBe(true);
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
