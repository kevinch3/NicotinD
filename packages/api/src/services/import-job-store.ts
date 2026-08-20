/**
 * Row store for admin folder-import jobs (docs/import.md). `import_jobs` is
 * authoritative; every job also mirrors an item-less row into the unified
 * `acquisition_jobs` table (same id, kind='import') so the Downloads feed
 * renders it — the same authoritative/mirror split `acquire_jobs` uses.
 * Mirror writes are best-effort: a feed hiccup must never fail an import.
 */
import type { Database } from 'bun:sqlite';
import { cleanFolderName, createLogger } from '@nicotind/core';
import { archiveDisplayName, looksLikeArchive } from './import-archive.js';
import type {
  AcquireAlbumDestination,
  ImportJob,
  ImportJobDir,
  ImportJobState,
  ImportJobSummary,
  PipelineStage,
} from '@nicotind/core';
import { createJob } from './acquisition-job-store.js';

const log = createLogger('import-job-store');

const IMPORT_JOB_TTL_SECONDS = 7 * 24 * 60 * 60;

interface ImportJobRow {
  id: string;
  source_path: string;
  remove_originals: number;
  state: string;
  stage: string | null;
  error: string | null;
  files_total: number;
  files_done: number;
  bytes_total: number;
  current_dir: string | null;
  summary_json: string | null;
  dest_albums_json: string | null;
  started_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateImportJobInput {
  id: string;
  sourcePath: string;
  removeOriginals: boolean;
  filesTotal: number;
  bytesTotal: number;
  startedBy: string | null;
}

export function createImportJob(db: Database, input: CreateImportJobInput): void {
  const now = Date.now();
  db.run(
    `INSERT INTO import_jobs
       (id, source_path, remove_originals, state, stage, files_total, bytes_total, started_by,
        created_at, updated_at)
     VALUES (?, ?, ?, 'queued', 'queued', ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.sourcePath,
      input.removeOriginals ? 1 : 0,
      input.filesTotal,
      input.bytesTotal,
      input.startedBy,
      now,
      now,
    ],
  );
  try {
    createJob(db, {
      id: input.id,
      kind: 'import',
      method: 'import',
      // The folder (or archive) the admin pointed at, not its absolute path:
      // the card used to fall all the way through to `sourceRef` and render
      // `/mnt/media/incoming/Bootleg Rips 2019` as its title.
      displayTitle: importDisplayTitle(input.sourcePath),
      sourceRef: input.sourcePath,
      stage: 'queued',
    });
  } catch (err) {
    log.warn({ id: input.id, err }, 'Failed to mirror import job into acquisition_jobs');
  }
}

export interface ImportJobPatch {
  state?: ImportJobState;
  stage?: PipelineStage;
  error?: string | null;
  filesDone?: number;
  currentDir?: string | null;
  summary?: ImportJobSummary;
  destAlbums?: AcquireAlbumDestination[];
  /** Single-album convenience: lights "Open in Library" on the feed card. */
  mirrorAlbum?: { artistName: string; albumTitle: string } | null;
}

export function updateImportJob(db: Database, id: string, patch: ImportJobPatch): void {
  const sets: string[] = ['updated_at = ?'];
  const args: (string | number | null)[] = [Date.now()];
  if (patch.state !== undefined) {
    sets.push('state = ?');
    args.push(patch.state);
  }
  if (patch.stage !== undefined) {
    sets.push('stage = ?');
    args.push(patch.stage);
  }
  if (patch.error !== undefined) {
    sets.push('error = ?');
    args.push(patch.error);
  }
  if (patch.filesDone !== undefined) {
    sets.push('files_done = ?');
    args.push(patch.filesDone);
  }
  if (patch.currentDir !== undefined) {
    sets.push('current_dir = ?');
    args.push(patch.currentDir);
  }
  if (patch.summary !== undefined) {
    sets.push('summary_json = ?');
    args.push(JSON.stringify(patch.summary));
  }
  if (patch.destAlbums !== undefined) {
    sets.push('dest_albums_json = ?');
    args.push(JSON.stringify(patch.destAlbums));
  }
  db.run(`UPDATE import_jobs SET ${sets.join(', ')} WHERE id = ?`, [...args, id]);
  mirrorImportJob(db, id, patch);
}

/** Best-effort mirror of state/stage/error (+ single-album identity) into acquisition_jobs. */
function mirrorImportJob(db: Database, id: string, patch: ImportJobPatch): void {
  try {
    const sets: string[] = ['updated_at = ?'];
    const args: (string | number | null)[] = [Date.now()];
    if (patch.state !== undefined) {
      // queued/running collapse to the unified 'active'; a cancelled import is
      // terminal-without-success, which the feed model only knows as 'failed'.
      const mirrored =
        patch.state === 'queued' || patch.state === 'running'
          ? 'active'
          : patch.state === 'cancelled'
            ? 'failed'
            : patch.state;
      sets.push('state = ?');
      args.push(mirrored);
    }
    if (patch.stage !== undefined) {
      sets.push('stage = ?');
      args.push(patch.stage);
    }
    if (patch.error !== undefined) {
      sets.push('error = ?');
      args.push(patch.error);
    }
    if (patch.mirrorAlbum !== undefined) {
      // Clear the folder-derived display title once the real album is known:
      // it is rung 1 of the title chain, so leaving it would pin the card to
      // "Bootleg Rips 2019" forever instead of upgrading to the album it
      // actually landed as. A source folder is a placeholder, not an answer.
      sets.push('artist_name = ?', 'album_title = ?', 'display_title = ?');
      args.push(
        patch.mirrorAlbum?.artistName ?? null,
        patch.mirrorAlbum?.albumTitle ?? null,
        patch.mirrorAlbum?.albumTitle ? null : importDisplayTitle(sourcePathOf(db, id) ?? ''),
      );
    }
    if (sets.length === 1) return;
    db.run(`UPDATE acquisition_jobs SET ${sets.join(', ')} WHERE id = ?`, [...args, id]);
  } catch (err) {
    log.warn({ id, err }, 'Failed to mirror import job update');
  }
}

/** Register a job's source dirs. INSERT OR IGNORE so a retry keeps 'done' rows. */
export function upsertImportDirs(
  db: Database,
  jobId: string,
  dirs: Array<{ dir: string; fileCount: number }>,
): void {
  const insert = db.transaction(() => {
    for (const d of dirs) {
      db.run(
        `INSERT OR IGNORE INTO import_job_dirs (job_id, source_dir, file_count, state)
         VALUES (?, ?, ?, 'pending')`,
        [jobId, d.dir, d.fileCount],
      );
    }
  });
  insert();
}

export function markImportDir(
  db: Database,
  jobId: string,
  sourceDir: string,
  state: 'pending' | 'done' | 'failed',
  error?: string | null,
): void {
  db.run(`UPDATE import_job_dirs SET state = ?, error = ? WHERE job_id = ? AND source_dir = ?`, [
    state,
    error ?? null,
    jobId,
    sourceDir,
  ]);
}

export function listImportDirs(db: Database, jobId: string): ImportJobDir[] {
  return db
    .query<
      { source_dir: string; file_count: number; state: string; error: string | null },
      [string]
    >(`SELECT source_dir, file_count, state, error FROM import_job_dirs WHERE job_id = ?`)
    .all(jobId)
    .map((r) => ({
      sourceDir: r.source_dir,
      fileCount: r.file_count,
      state: r.state as ImportJobDir['state'],
      error: r.error,
    }));
}

export function getImportJob(db: Database, id: string): ImportJob | null {
  const row = db.query<ImportJobRow, [string]>(`SELECT * FROM import_jobs WHERE id = ?`).get(id);
  return row ? mapRow(row) : null;
}

export function listImportJobs(db: Database, limit = 20): ImportJob[] {
  return db
    .query<ImportJobRow, [number]>(`SELECT * FROM import_jobs ORDER BY created_at DESC LIMIT ?`)
    .all(limit)
    .map(mapRow);
}

export function deleteImportJob(db: Database, id: string): boolean {
  const row = db
    .query<{ id: string }, [string]>(
      `SELECT id FROM import_jobs WHERE id = ? AND state IN ('done', 'failed', 'cancelled')`,
    )
    .get(id);
  if (!row) return false;
  // Explicit child delete: FK cascade needs PRAGMA foreign_keys, which this
  // codebase doesn't rely on (see acquisition-job-store's deleteJob note).
  db.run(`DELETE FROM import_job_dirs WHERE job_id = ?`, [id]);
  db.run(`DELETE FROM import_jobs WHERE id = ?`, [id]);
  try {
    db.run(`DELETE FROM acquisition_jobs WHERE id = ? AND kind = 'import'`, [id]);
  } catch (err) {
    log.warn({ id, err }, 'Failed to delete import mirror row');
  }
  return true;
}

/**
 * Boot hygiene (AcquireWatcher pattern): jobs left queued/running by a dead
 * process are orphans — fail them so they don't sit "running" forever — and
 * finished jobs older than 7 days are pruned. Returns the ids so the service
 * can roll back / remove their staging dirs.
 */
export function reconcileImportJobsOnBoot(db: Database): {
  orphaned: Array<{ id: string; sourcePath: string; removeOriginals: boolean }>;
  pruned: string[];
} {
  const orphaned = db
    .query<{ id: string; source_path: string; remove_originals: number }, []>(
      `SELECT id, source_path, remove_originals FROM import_jobs
        WHERE state IN ('queued', 'running')`,
    )
    .all()
    .map((r) => ({
      id: r.id,
      sourcePath: r.source_path,
      removeOriginals: r.remove_originals === 1,
    }));
  for (const job of orphaned) {
    updateImportJob(db, job.id, {
      state: 'failed',
      stage: 'error',
      error: 'Interrupted by a server restart — use Retry to run it again',
    });
  }
  const cutoff = Date.now() - IMPORT_JOB_TTL_SECONDS * 1000;
  const pruned = db
    .query<{ id: string }, [number]>(
      `SELECT id FROM import_jobs WHERE state IN ('done', 'failed', 'cancelled') AND created_at < ?`,
    )
    .all(cutoff)
    .map((r) => r.id);
  for (const id of pruned) {
    db.run(`DELETE FROM import_job_dirs WHERE job_id = ?`, [id]);
    db.run(`DELETE FROM import_jobs WHERE id = ?`, [id]);
    try {
      db.run(`DELETE FROM acquisition_jobs WHERE id = ? AND kind = 'import'`, [id]);
    } catch {
      /* mirror cleanup is best-effort */
    }
  }
  return { orphaned, pruned };
}

function mapRow(row: ImportJobRow): ImportJob {
  let summary: ImportJobSummary | null = null;
  if (row.summary_json) {
    try {
      summary = JSON.parse(row.summary_json);
    } catch {
      /* ignore */
    }
  }
  let destinationAlbums: AcquireAlbumDestination[] = [];
  if (row.dest_albums_json) {
    try {
      destinationAlbums = JSON.parse(row.dest_albums_json);
    } catch {
      /* ignore */
    }
  }
  return {
    id: row.id,
    sourcePath: row.source_path,
    removeOriginals: row.remove_originals === 1,
    state: row.state as ImportJobState,
    stage: (row.stage as PipelineStage) ?? null,
    error: row.error,
    filesTotal: row.files_total,
    filesDone: row.files_done,
    bytesTotal: row.bytes_total,
    currentDir: row.current_dir,
    summary,
    destinationAlbums,
    startedBy: row.started_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The folder an import job was started from (for restoring its placeholder title). */
function sourcePathOf(db: Database, id: string): string | null {
  try {
    return (
      db
        .query<{ source_path: string }, [string]>(
          `SELECT source_path FROM import_jobs WHERE id = ?`,
        )
        .get(id)?.source_path ?? null
    );
  } catch {
    return null;
  }
}

/** Card title for an import source: the folder name, or the archive's stem. */
function importDisplayTitle(sourcePath: string): string | null {
  const raw = looksLikeArchive(sourcePath) ? archiveDisplayName(sourcePath) : sourcePath;
  return cleanFolderName(raw) || null;
}
