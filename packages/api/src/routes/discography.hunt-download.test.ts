import { describe, it, expect, beforeEach, mock } from 'bun:test';
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
import { albumIdFor, artistIdFor } from '../services/library-scanner.js';

const noopSourceHunt = {
  hunt: async () => [],
  enabledSourceIds: () => [],
} as unknown as AlbumHuntOrchestrator;
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
      sourceHunt: noopSourceHunt,
      lidarr,
      db,
      slskdRef: { current: { transfers: { enqueue } } } as unknown as SlskdRef,
    }),
  );
  return { app, enqueue };
}

const BODY = {
  selected: {
    username: 'peer',
    directory: 'Soda Stereo - Dynamo',
    files: [{ filename: '01 One.flac', size: 1 }],
  },
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
    db
      .query(`SELECT count(*) c FROM album_jobs WHERE lidarr_album_id = ? AND state = 'active'`)
      .get(ALBUM_ID) as {
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

  it('wraps the download in a unified acquisition job linked to the fallback job', async () => {
    const { app } = makeApp(db);
    await post(app);
    const job = db
      .query(
        `SELECT kind, method, artist_name, album_title, lidarr_album_id, album_job_id, source_ref
         FROM acquisition_jobs`,
      )
      .get() as {
      kind: string;
      method: string;
      artist_name: string;
      album_title: string;
      lidarr_album_id: number;
      album_job_id: number | null;
      source_ref: string;
    };
    expect(job.kind).toBe('album-hunt');
    expect(job.method).toBe('slskd');
    expect(job.artist_name).toBe('Soda Stereo');
    expect(job.album_title).toBe('Dynamo');
    expect(job.lidarr_album_id).toBe(ALBUM_ID);
    expect(job.source_ref).toBe('peer');
    // Owned fallback detail: the album_jobs row the hunt recorded.
    const albumJob = db.query(`SELECT id FROM album_jobs`).get() as { id: number };
    expect(job.album_job_id).toBe(albumJob.id);

    const item = db.query(`SELECT transfer_key, state FROM acquisition_job_items`).get() as {
      transfer_key: string;
      state: string;
    };
    expect(item.transfer_key).toBe('peer::01 One.flac');
    expect(item.state).toBe('downloading');
  });

  it('replace=true supersedes the prior unified job too', async () => {
    const { app } = makeApp(db);
    await post(app);
    await post(app, '?replace=true');
    const states = db.query(`SELECT state FROM acquisition_jobs`).all() as Array<{
      state: string;
    }>;
    expect(states.map((s) => s.state).sort()).toEqual(['active', 'superseded']);
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
       VALUES ('alb1', 'Dynamo', 'Soda Stereo', ?, ?, 1)`,
      [artistIdFor('Soda Stereo'), TRACKS.length],
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
        sourceHunt: noopSourceHunt,
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

  it('persists the acquired artist identity (+MBID) from the Lidarr payload', async () => {
    const enqueue = mock(async () => undefined);
    const lidarr = {
      album: {
        get: mock(async () => ({
          title: 'Dynamo',
          artist: { artistName: 'Soda Stereo', foreignArtistId: 'mbid-soda' },
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
        sourceHunt: noopSourceHunt,
        lidarr,
        db,
        slskdRef: { current: { transfers: { enqueue } } } as unknown as SlskdRef,
      }),
    );

    const res = await post(app);
    expect(res.status).toBe(201);
    const identity = db
      .query<{ raw_name: string; decision: string; source: string }, [string]>(
        'SELECT raw_name, decision, source FROM library_artist_identity WHERE artist_key = ?',
      )
      .get(artistIdFor('Soda Stereo'));
    expect(identity).toEqual({ raw_name: 'Soda Stereo', decision: 'single', source: 'lidarr' });
    const link = db
      .query<{ mbid: string }, [string]>(
        'SELECT mbid FROM artist_discography_links WHERE artist_id = ?',
      )
      .get(artistIdFor('Soda Stereo'));
    expect(link?.mbid).toBe('mbid-soda');
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
    for (const [id, title] of [
      ['s1', 'One'],
      ['s2', 'Two'],
      ['s3', 'Three'],
    ]) {
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
       VALUES ('alb1', 'Dynamo (Deluxe Edition)', 'Soda Stereo', ?, ?, 1)`,
      [artistIdFor('Soda Stereo'), TRACKS.length],
    );
    const res = await post(app);
    expect(res.status).toBe(409);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
