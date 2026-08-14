import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  createImportJob,
  deleteImportJob,
  getImportJob,
  listImportDirs,
  listImportJobs,
  markImportDir,
  reconcileImportJobsOnBoot,
  updateImportJob,
  upsertImportDirs,
} from './import-job-store.js';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

function seedJob(id = 'job-1'): void {
  createImportJob(db, {
    id,
    sourcePath: '/mnt/imports',
    removeOriginals: false,
    filesTotal: 10,
    bytesTotal: 1000,
    startedBy: 'admin-1',
  });
}

describe('createImportJob', () => {
  it('creates the row and an item-less mirror in acquisition_jobs', () => {
    seedJob();
    const job = getImportJob(db, 'job-1')!;
    expect(job.state).toBe('queued');
    expect(job.filesTotal).toBe(10);
    expect(job.destinationAlbums).toEqual([]);
    const mirror = db
      .query<{ kind: string; method: string; state: string; source_ref: string }, [string]>(
        `SELECT kind, method, state, source_ref FROM acquisition_jobs WHERE id = ?`,
      )
      .get('job-1');
    expect(mirror).toEqual({
      kind: 'import',
      method: 'import',
      state: 'active',
      source_ref: '/mnt/imports',
    });
    const items = db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM acquisition_job_items WHERE job_id = ?`,
      )
      .get('job-1');
    expect(items?.n).toBe(0);
  });
});

describe('updateImportJob', () => {
  it('mirrors state transitions (cancelled → failed) and album identity', () => {
    seedJob();
    updateImportJob(db, 'job-1', { state: 'running', stage: 'organizing', filesDone: 4 });
    let mirror = db
      .query<{ state: string; stage: string }, [string]>(
        `SELECT state, stage FROM acquisition_jobs WHERE id = ?`,
      )
      .get('job-1');
    expect(mirror).toEqual({ state: 'active', stage: 'organizing' });

    updateImportJob(db, 'job-1', {
      state: 'cancelled',
      stage: 'error',
      mirrorAlbum: { artistName: 'Artist', albumTitle: 'Album' },
    });
    const full = db
      .query<{ state: string; artist_name: string; album_title: string }, [string]>(
        `SELECT state, artist_name, album_title FROM acquisition_jobs WHERE id = ?`,
      )
      .get('job-1');
    expect(full).toEqual({ state: 'failed', artist_name: 'Artist', album_title: 'Album' });
    expect(getImportJob(db, 'job-1')!.state).toBe('cancelled');
    expect(getImportJob(db, 'job-1')!.filesDone).toBe(4);
  });

  it('round-trips summary and destination albums', () => {
    seedJob();
    updateImportJob(db, 'job-1', {
      summary: { imported: 3, skippedDuplicate: 1, unsorted: 0, failed: 0, removedOriginals: 0 },
      destAlbums: [{ albumArtist: 'A', albumTitle: 'B', albumId: 'x' }],
    });
    const job = getImportJob(db, 'job-1')!;
    expect(job.summary?.imported).toBe(3);
    expect(job.destinationAlbums).toHaveLength(1);
  });
});

describe('import dirs', () => {
  it('upsert keeps existing rows (retry contract) and marks states', () => {
    seedJob();
    upsertImportDirs(db, 'job-1', [
      { dir: 'A/One', fileCount: 5 },
      { dir: 'B/Two', fileCount: 5 },
    ]);
    markImportDir(db, 'job-1', 'A/One', 'done');
    // A retry re-upserts the same dirs — done state must survive.
    upsertImportDirs(db, 'job-1', [
      { dir: 'A/One', fileCount: 5 },
      { dir: 'B/Two', fileCount: 5 },
    ]);
    const dirs = listImportDirs(db, 'job-1');
    expect(dirs.find((d) => d.sourceDir === 'A/One')?.state).toBe('done');
    expect(dirs.find((d) => d.sourceDir === 'B/Two')?.state).toBe('pending');
  });
});

describe('deleteImportJob', () => {
  it('refuses in-flight jobs, removes finished ones with their mirror + dirs', () => {
    seedJob();
    upsertImportDirs(db, 'job-1', [{ dir: 'A', fileCount: 1 }]);
    expect(deleteImportJob(db, 'job-1')).toBe(false);
    updateImportJob(db, 'job-1', { state: 'done' });
    expect(deleteImportJob(db, 'job-1')).toBe(true);
    expect(getImportJob(db, 'job-1')).toBeNull();
    expect(listImportDirs(db, 'job-1')).toEqual([]);
    expect(db.query(`SELECT id FROM acquisition_jobs WHERE id = ?`).get('job-1')).toBeNull();
  });
});

describe('reconcileImportJobsOnBoot', () => {
  it('fails orphaned queued/running jobs and prunes stale finished ones', () => {
    seedJob('orphan');
    updateImportJob(db, 'orphan', { state: 'running' });
    seedJob('stale');
    updateImportJob(db, 'stale', { state: 'done' });
    db.run(`UPDATE import_jobs SET created_at = ? WHERE id = 'stale'`, [
      Date.now() - 8 * 24 * 60 * 60 * 1000,
    ]);
    seedJob('fresh');
    updateImportJob(db, 'fresh', { state: 'done' });

    const { orphaned, pruned } = reconcileImportJobsOnBoot(db);
    expect(orphaned.map((o) => o.id)).toEqual(['orphan']);
    expect(pruned).toEqual(['stale']);
    expect(getImportJob(db, 'orphan')?.state).toBe('failed');
    expect(getImportJob(db, 'orphan')?.error).toContain('Retry');
    expect(getImportJob(db, 'stale')).toBeNull();
    expect(getImportJob(db, 'fresh')?.state).toBe('done');
    expect(
      listImportJobs(db)
        .map((j) => j.id)
        .sort(),
    ).toEqual(['fresh', 'orphan']);
  });
});
