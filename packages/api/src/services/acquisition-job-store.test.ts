import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  createJob,
  getJob,
  jobMetaForTransfer,
  listJobFeed,
  markItemCompleted,
  markItemOrganized,
  markItemsScanned,
  markMissingItemsUnavailable,
  reconcileOnBoot,
  recomputeStage,
  repointItem,
  supersedeActiveJobs,
  transferKeyFor,
} from './acquisition-job-store.js';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

describe('createJob', () => {
  it('inserts a job with its items and returns the job id', () => {
    const id = createJob(db, {
      kind: 'album-hunt',
      method: 'slskd',
      artistName: 'David Bowie',
      albumTitle: 'Heathen',
      lidarrAlbumId: 42,
      genres: ['Rock', 'Art Rock'],
      year: 2002,
      canonicalTracks: ['Sunday', 'Slip Away'],
      sourceRef: 'peer1',
      username: 'peer1',
      files: [
        { filename: '@@abc\\Music\\Heathen\\01 Sunday.flac', size: 1, trackTitle: 'Sunday' },
        { filename: '@@abc\\Music\\Heathen\\02 Slip Away.flac', size: 2, trackTitle: 'Slip Away' },
      ],
    });
    expect(id).toBeTruthy();
    const job = getJob(db, id);
    expect(job?.artistName).toBe('David Bowie');
    expect(job?.albumTitle).toBe('Heathen');
    expect(job?.state).toBe('active');
    expect(job?.stage).toBe('downloading');
    expect(job?.genres).toEqual(['Rock', 'Art Rock']);
    expect(job?.year).toBe(2002);
    expect(job?.items).toHaveLength(2);
  });

  it('auto-matches item track titles from the canonical tracklist when not given', () => {
    const id = createJob(db, {
      kind: 'album-hunt',
      method: 'slskd',
      username: 'peer1',
      canonicalTracks: ['Sunday', 'Slip Away', '5:15 The Angels Have Gone'],
      files: [
        { filename: '@@x\\Heathen\\02 Slip Away.flac' },
        { filename: '@@x\\Heathen\\99 Unrelated Bonus.flac' },
      ],
    });
    const items = getJob(db, id)!.items;
    expect(items[0].trackTitle).toBe('Slip Away');
    expect(items[1].trackTitle).toBeNull();
  });

  it('stores the exact transfer key — backslashes and case preserved, never normalized', () => {
    const filename = '@@Xy\\MUSIC\\Album (2002)\\01 - Träck.FLAC';
    createJob(db, {
      kind: 'direct',
      method: 'slskd',
      username: 'PeerCase',
      files: [{ filename, size: 1 }],
    });
    const row = db
      .query<{ transfer_key: string }, []>(`SELECT transfer_key FROM acquisition_job_items`)
      .get();
    expect(row?.transfer_key).toBe(`PeerCase::${filename}`);
    expect(row?.transfer_key).toBe(transferKeyFor('PeerCase', filename));
  });
});

describe('jobMetaForTransfer', () => {
  it('resolves job metadata by exact (username, filename)', () => {
    const id = createJob(db, {
      kind: 'album-hunt',
      method: 'slskd',
      artistName: 'Bowie',
      albumTitle: 'Heathen',
      username: 'peer1',
      canonicalTracks: ['Sunday'],
      files: [{ filename: 'a\\b\\01.flac', size: 1, trackTitle: 'Sunday' }],
    });
    const meta = jobMetaForTransfer(db, 'peer1', 'a\\b\\01.flac');
    expect(meta?.jobId).toBe(id);
    expect(meta?.artistName).toBe('Bowie');
    expect(meta?.albumTitle).toBe('Heathen');
    expect(meta?.canonicalTracks).toEqual(['Sunday']);
  });

  it('returns null for an unknown transfer', () => {
    expect(jobMetaForTransfer(db, 'peer1', 'nope.flac')).toBeNull();
  });
});

/** Create a two-track slskd job for lifecycle tests. */
function seedJob(overrides: { lidarrAlbumId?: number } = {}): string {
  return createJob(db, {
    kind: 'album-hunt',
    method: 'slskd',
    artistName: 'Bowie',
    albumTitle: 'Heathen',
    lidarrAlbumId: overrides.lidarrAlbumId ?? null,
    username: 'peer1',
    canonicalTracks: ['Sunday', 'Slip Away'],
    files: [
      { filename: 'a\\01 Sunday.flac', trackTitle: 'Sunday' },
      { filename: 'a\\02 Slip Away.flac', trackTitle: 'Slip Away' },
    ],
  });
}

function itemStates(id: string): string[] {
  return (getJob(db, id)?.items ?? []).map((i) => i.state);
}

/** Insert a landed (or quarantined) library song so scanned items can resolve. */
function seedSong(songId: string, path: string, landed: boolean): void {
  db.run(
    `INSERT OR IGNORE INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
     VALUES ('al', 'Heathen', 'Bowie', 'art', 2, 0, 1)`,
  );
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, created, landed_at, synced_at)
     VALUES (?, 'al', ?, 'Bowie', 'art', 0, ?, 10, '2024-01-01', ?, 1)`,
    [songId, songId, path, landed ? 1 : null],
  );
}

describe('item lifecycle', () => {
  it('marks completion, organization and scan on the same item row', () => {
    const id = seedJob();
    markItemCompleted(db, transferKeyFor('peer1', 'a\\01 Sunday.flac'));
    expect(itemStates(id)).toEqual(['completed', 'downloading']);

    markItemOrganized(db, transferKeyFor('peer1', 'a\\01 Sunday.flac'), 'Bowie/Heathen/01.opus');
    const afterOrganize = getJob(db, id)!.items[0];
    expect(afterOrganize.state).toBe('organized');
    expect(afterOrganize.relativePath).toBe('Bowie/Heathen/01.opus');

    markItemsScanned(db, new Map([['Bowie/Heathen/01.opus', 's1']]));
    const afterScan = getJob(db, id)!.items[0];
    expect(afterScan.state).toBe('scanned');
    expect(afterScan.songId).toBe('s1');
  });
});

describe('listJobFeed', () => {
  it('maps every acquisition_job_items state onto the shared TrackStatus union', () => {
    const id = createJob(db, {
      kind: 'album-hunt',
      method: 'slskd',
      artistName: 'Bowie',
      albumTitle: 'Heathen',
      username: 'peer1',
      files: [
        { filename: 'a\\01.flac', trackTitle: 'Downloading Track' },
        { filename: 'a\\02.flac', trackTitle: 'Completed Track' },
        { filename: 'a\\03.flac', trackTitle: 'Organized Track' },
        { filename: 'a\\04.flac', trackTitle: 'Scanned Track' },
        { filename: 'a\\05.flac', trackTitle: 'Failed Track' },
        { filename: 'a\\06.flac', trackTitle: 'Unavailable Track' },
      ],
    });
    // 'downloading' is already the state createJob leaves items in; drive the
    // rest directly via SQL — these states are otherwise only reachable
    // through multi-step lifecycle calls this test doesn't need.
    db.run(`UPDATE acquisition_job_items SET state = 'completed' WHERE track_title = ?`, [
      'Completed Track',
    ]);
    db.run(`UPDATE acquisition_job_items SET state = 'organized' WHERE track_title = ?`, [
      'Organized Track',
    ]);
    db.run(`UPDATE acquisition_job_items SET state = 'scanned' WHERE track_title = ?`, [
      'Scanned Track',
    ]);
    db.run(`UPDATE acquisition_job_items SET state = 'failed' WHERE track_title = ?`, [
      'Failed Track',
    ]);
    db.run(`UPDATE acquisition_job_items SET state = 'unavailable' WHERE track_title = ?`, [
      'Unavailable Track',
    ]);

    const feed = listJobFeed(db);
    const job = feed.find((j) => j.id === id);
    expect(job).toBeDefined();
    const items = job!.items;
    expect(items).toHaveLength(6);
    expect(items.find((i) => i.title === 'Downloading Track')?.status).toBe('downloading');
    expect(items.find((i) => i.title === 'Completed Track')?.status).toBe('done');
    expect(items.find((i) => i.title === 'Organized Track')?.status).toBe('done');
    expect(items.find((i) => i.title === 'Scanned Track')?.status).toBe('done');
    expect(items.find((i) => i.title === 'Failed Track')?.status).toBe('failed');
    expect(items.find((i) => i.title === 'Unavailable Track')?.status).toBe('skipped');
  });

  it('falls back to pending for an unrecognized/legacy state value', () => {
    const id = createJob(db, {
      kind: 'direct',
      method: 'slskd',
      username: 'peer1',
      files: [{ filename: 'a\\01.flac', trackTitle: 'Mystery Track' }],
    });
    db.run(`UPDATE acquisition_job_items SET state = 'queued' WHERE track_title = ?`, [
      'Mystery Track',
    ]);
    const job = listJobFeed(db).find((j) => j.id === id);
    expect(job!.items[0].status).toBe('pending');
  });
});

describe('repointItem', () => {
  it('re-points the matching non-completed item to a new peer, bumping attempts', () => {
    const id = seedJob();
    markItemCompleted(db, transferKeyFor('peer1', 'a\\01 Sunday.flac'));

    const ok = repointItem(db, id, 'Slip Away', 'peer2', 'x\\Slip Away.mp3');
    expect(ok).toBe(true);
    const item = getJob(db, id)!.items[1];
    expect(item.username).toBe('peer2');
    expect(item.transferKey).toBe(transferKeyFor('peer2', 'x\\Slip Away.mp3'));
    expect(item.attempts).toBe(2);
    expect(item.state).toBe('downloading');
  });

  it('never re-points a completed item', () => {
    const id = seedJob();
    markItemCompleted(db, transferKeyFor('peer1', 'a\\01 Sunday.flac'));
    const ok = repointItem(db, id, 'Sunday', 'peer2', 'x\\Sunday.mp3');
    expect(ok).toBe(false);
    expect(getJob(db, id)!.items[0].username).toBe('peer1');
  });
});

describe('recomputeStage', () => {
  it('walks downloading → organizing → scanning → processing → done', () => {
    const id = seedJob();
    expect(recomputeStage(db, id)).toBe('downloading');

    markItemCompleted(db, transferKeyFor('peer1', 'a\\01 Sunday.flac'));
    markItemCompleted(db, transferKeyFor('peer1', 'a\\02 Slip Away.flac'));
    expect(recomputeStage(db, id)).toBe('organizing');

    markItemOrganized(db, transferKeyFor('peer1', 'a\\01 Sunday.flac'), 'p/01.opus');
    markItemOrganized(db, transferKeyFor('peer1', 'a\\02 Slip Away.flac'), 'p/02.opus');
    expect(recomputeStage(db, id)).toBe('scanning');

    seedSong('s1', 'p/01.opus', false);
    seedSong('s2', 'p/02.opus', false);
    markItemsScanned(
      db,
      new Map([
        ['p/01.opus', 's1'],
        ['p/02.opus', 's2'],
      ]),
    );
    expect(recomputeStage(db, id)).toBe('processing');

    db.run(`UPDATE library_songs SET landed_at = 2`);
    expect(recomputeStage(db, id)).toBe('done');
    expect(getJob(db, id)?.state).toBe('done');
  });

  it('closes a job as partial done when remaining items are unavailable — never waits 13 of 13', () => {
    const id = seedJob();
    markItemCompleted(db, transferKeyFor('peer1', 'a\\01 Sunday.flac'));
    markItemOrganized(db, transferKeyFor('peer1', 'a\\01 Sunday.flac'), 'p/01.opus');
    seedSong('s1', 'p/01.opus', true);
    markItemsScanned(db, new Map([['p/01.opus', 's1']]));

    markMissingItemsUnavailable(db, id);
    expect(recomputeStage(db, id)).toBe('done');
    const job = getJob(db, id)!;
    expect(job.state).toBe('done');
    expect(job.items.map((i) => i.state).sort()).toEqual(['scanned', 'unavailable']);
  });

  it('fails the job when every item is failed or unavailable', () => {
    const id = seedJob();
    markMissingItemsUnavailable(db, id);
    expect(recomputeStage(db, id)).toBe('error');
    expect(getJob(db, id)?.state).toBe('failed');
  });
});

describe('supersedeActiveJobs', () => {
  it('supersedes active jobs for the same Lidarr album', () => {
    const oldId = seedJob({ lidarrAlbumId: 42 });
    supersedeActiveJobs(db, { lidarrAlbumId: 42 });
    expect(getJob(db, oldId)?.state).toBe('superseded');
  });
});

describe('reconcileOnBoot', () => {
  it('closes out jobs whose non-terminal items have been idle past the valve', () => {
    const id = seedJob();
    db.run(`UPDATE acquisition_job_items SET updated_at = 1`); // ancient
    db.run(`UPDATE acquisition_jobs SET created_at = 1, updated_at = 1`);
    reconcileOnBoot(db);
    const job = getJob(db, id)!;
    expect(job.items.every((i) => i.state === 'failed')).toBe(true);
    expect(job.state).toBe('failed');
  });

  it('leaves fresh active jobs alone and prunes old finished jobs', () => {
    const fresh = seedJob();
    const old = seedJob();
    db.run(`UPDATE acquisition_jobs SET state = 'done', created_at = 1, updated_at = 1 WHERE id = ?`, [
      old,
    ]);
    reconcileOnBoot(db);
    expect(getJob(db, fresh)?.state).toBe('active');
    expect(getJob(db, old)).toBeNull();
    // Items cascade with the job
    const orphans = db
      .query<{ c: number }, [string]>(
        `SELECT COUNT(*) c FROM acquisition_job_items WHERE job_id = ?`,
      )
      .get(old);
    expect(orphans?.c).toBe(0);
  });
});
