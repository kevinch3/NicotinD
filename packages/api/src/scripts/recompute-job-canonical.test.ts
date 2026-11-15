import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { createJob } from '../services/acquisition-job-store.js';
import { applyCanonicalRecompute, planCanonicalRecompute } from './recompute-job-canonical.js';

const STANDARD = ['Crush With Eyeliner', 'King of Comedy'];
const BOX_SET = [...STANDARD, 'Crush With Eyeliner (demo)', 'Revolution'];

/** Album 1401 is the box-set case; album 7 has one edition. */
const lidarr = {
  album: {
    get: async (id: number) =>
      id === 1401
        ? {
            releases: [
              { id: 10, trackCount: 2, status: 'Official', monitored: false },
              { id: 11, trackCount: 2, status: 'Official', monitored: false },
              { id: 12, trackCount: 4, status: 'Official', monitored: true },
            ],
          }
        : { releases: [{ id: 70, trackCount: 2, status: 'Official', monitored: true }] },
  },
  track: {
    listByAlbum: async (id: number) =>
      (id === 1401 ? BOX_SET : STANDARD).map((title) => ({ title })),
    listByRelease: async () => STANDARD.map((title) => ({ title })),
  },
} as never;

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

function job(lidarrAlbumId: number, canonicalTracks: string[], createdAt = 1_000): string {
  const id = createJob(db, {
    kind: 'album-hunt',
    method: 'slskd',
    albumTitle: `Album ${lidarrAlbumId}`,
    lidarrAlbumId,
    canonicalTracks,
  });
  db.run(`UPDATE acquisition_jobs SET created_at = ? WHERE id = ?`, [createdAt, id]);
  return id;
}

const stored = (id: string) =>
  JSON.parse(
    db
      .query<{ canonical_tracks_json: string }, [string]>(
        'SELECT canonical_tracks_json FROM acquisition_jobs WHERE id = ?',
      )
      .get(id)!.canonical_tracks_json,
  ) as string[];

const window = { sinceMs: 0, beforeMs: 10_000 };

describe('planCanonicalRecompute (#1936)', () => {
  it('rewrites a job that stored the monitored box set to the standard edition', async () => {
    const id = job(1401, BOX_SET);
    const plan = await planCanonicalRecompute(db, lidarr, window);
    expect(plan).toEqual([{ jobId: id, album: 'Album 1401', from: 4, to: 2, titles: STANDARD }]);

    applyCanonicalRecompute(db, plan);
    expect(stored(id)).toEqual(STANDARD);
  });

  it('leaves a hand-picked deluxe job alone: it stored the standard tracks plus its extras', async () => {
    job(1401, [...STANDARD, 'Revolution']);
    expect(await planCanonicalRecompute(db, lidarr, window)).toEqual([]);
  });

  it('leaves a job that already carries the standard edition, or a single-edition album', async () => {
    job(1401, STANDARD);
    job(7, STANDARD);
    expect(await planCanonicalRecompute(db, lidarr, window)).toEqual([]);
  });

  it('only looks inside the window', async () => {
    job(1401, BOX_SET, 50_000);
    expect(await planCanonicalRecompute(db, lidarr, window)).toEqual([]);
  });
});
