import type { Database } from 'bun:sqlite';
import {
  normalizeTitle,
  type AddonJob,
  type AddonJobIntent,
  type AddonJobItem,
  type AddonJobItemState,
  type AddonJobState,
} from '@nicotind/core';

/**
 * The protocol job ledger (`addon_jobs`/`addon_job_items`) — what the host
 * polls via GET /addon/v1/jobs. Item identity is the repoint contract: a
 * titled item keeps its `t:<normalized title>` id across fallback re-pulls
 * (only username/filename flip), so the host's mirror upsert reproduces
 * repoint semantics without knowing fallback exists.
 */

export function itemIdForTitle(title: string): string {
  return `t:${normalizeTitle(title)}`;
}

export function itemIdForFile(filename: string): string {
  const base = filename.replace(/\\/g, '/').split('/').pop() ?? filename;
  return `f:${base.toLowerCase()}`;
}

export interface NewJobItem {
  itemId: string;
  title: string | null;
  username: string;
  filename: string;
  size: number;
  bitRateKbps?: number;
  audioFormat?: string;
}

interface JobRow {
  id: string;
  intent: string;
  artist: string | null;
  album: string | null;
  album_job_id: number | null;
  state: string;
  error: string | null;
  created_at: number;
  updated_at: number;
}

interface ItemRow {
  job_id: string;
  item_id: string;
  title: string | null;
  username: string;
  filename: string;
  size: number;
  bit_rate_kbps: number | null;
  audio_format: string | null;
  state: string;
  bytes_transferred: number | null;
  file_ready: number;
  updated_at: number;
}

export function createAddonJob(
  db: Database,
  input: {
    id: string;
    intent: AddonJobIntent;
    artist?: string | null;
    album?: string | null;
    canonicalTracks?: Array<{ title: string }>;
    albumJobId?: number | null;
  },
): void {
  const now = Date.now();
  db.run(
    `INSERT INTO addon_jobs (id, intent, artist, album, canonical_tracks_json, album_job_id, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    [
      input.id,
      input.intent,
      input.artist ?? null,
      input.album ?? null,
      input.canonicalTracks ? JSON.stringify(input.canonicalTracks) : null,
      input.albumJobId ?? null,
      now,
      now,
    ],
  );
}

export function addJobItems(db: Database, jobId: string, items: NewJobItem[]): void {
  const now = Date.now();
  for (const item of items) {
    db.run(
      `INSERT INTO addon_job_items (job_id, item_id, title, username, filename, size, bit_rate_kbps, audio_format, state, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)
       ON CONFLICT(job_id, item_id) DO UPDATE SET
         username = excluded.username, filename = excluded.filename,
         size = excluded.size, bit_rate_kbps = excluded.bit_rate_kbps,
         audio_format = excluded.audio_format, state = 'queued',
         bytes_transferred = NULL, file_ready = 0, updated_at = excluded.updated_at`,
      [
        jobId,
        item.itemId,
        item.title,
        item.username,
        item.filename,
        item.size,
        item.bitRateKbps ?? null,
        item.audioFormat ?? null,
        now,
      ],
    );
  }
  touchJob(db, jobId, now);
}

/**
 * A fallback wave re-pulled a titled item from another peer: same itemId, new
 * transfer coordinates, state back to queued.
 */
export function repointJobItem(
  db: Database,
  jobId: string,
  itemId: string,
  next: { username: string; filename: string; bitRateKbps?: number; audioFormat?: string },
): void {
  const now = Date.now();
  db.run(
    `UPDATE addon_job_items
     SET username = ?, filename = ?, bit_rate_kbps = COALESCE(?, bit_rate_kbps),
         audio_format = COALESCE(?, audio_format), state = 'queued',
         bytes_transferred = NULL, file_ready = 0, updated_at = ?
     WHERE job_id = ? AND item_id = ?`,
    [
      next.username,
      next.filename,
      next.bitRateKbps ?? null,
      next.audioFormat ?? null,
      now,
      jobId,
      itemId,
    ],
  );
  touchJob(db, jobId, now);
}

export function setItemState(
  db: Database,
  jobId: string,
  itemId: string,
  state: AddonJobItemState,
  opts: { bytesTransferred?: number; fileReady?: boolean } = {},
): void {
  const now = Date.now();
  db.run(
    `UPDATE addon_job_items
     SET state = ?, bytes_transferred = COALESCE(?, bytes_transferred),
         file_ready = COALESCE(?, file_ready), updated_at = ?
     WHERE job_id = ? AND item_id = ?`,
    [
      state,
      opts.bytesTransferred ?? null,
      opts.fileReady === undefined ? null : opts.fileReady ? 1 : 0,
      now,
      jobId,
      itemId,
    ],
  );
  touchJob(db, jobId, now);
}

/** Transfer completion sync: match items by (username, filename) across jobs. */
export function markItemsCompletedByTransfer(
  db: Database,
  completions: Array<{ username: string; filename: string; fileReady: boolean }>,
): void {
  const now = Date.now();
  for (const c of completions) {
    db.run(
      `UPDATE addon_job_items
       SET state = 'completed', file_ready = ?, updated_at = ?
       WHERE username = ? AND filename = ? AND state != 'completed'`,
      [c.fileReady ? 1 : 0, now, c.username, c.filename],
    );
  }
  // Recompute every touched active job.
  const jobs = db
    .query<{ id: string }, []>(`SELECT id FROM addon_jobs WHERE state = 'active'`)
    .all();
  for (const job of jobs) recomputeJobState(db, job.id);
}

export function setJobState(
  db: Database,
  jobId: string,
  state: AddonJobState,
  error?: string,
): void {
  db.run(`UPDATE addon_jobs SET state = ?, error = ?, updated_at = ? WHERE id = ?`, [
    state,
    error ?? null,
    Date.now(),
    jobId,
  ]);
}

/** Every item terminal → done (all completed) / partial (some) / failed (none). */
export function recomputeJobState(db: Database, jobId: string): void {
  const items = db
    .query<{ state: string }, [string]>(`SELECT state FROM addon_job_items WHERE job_id = ?`)
    .all(jobId);
  if (!items.length) return;
  const terminal = new Set(['completed', 'failed', 'unavailable']);
  if (!items.every((i) => terminal.has(i.state))) return;
  const completed = items.filter((i) => i.state === 'completed').length;
  const state: AddonJobState =
    completed === items.length ? 'done' : completed > 0 ? 'partial' : 'failed';
  setJobState(db, jobId, state);
}

export function addonJobIdForAlbumJob(db: Database, albumJobId: number): string | null {
  const row = db
    .query<{ id: string }, [number]>(`SELECT id FROM addon_jobs WHERE album_job_id = ?`)
    .get(albumJobId);
  return row?.id ?? null;
}

export function getAddonJob(db: Database, id: string): AddonJob | null {
  const row = db.query<JobRow, [string]>(`SELECT * FROM addon_jobs WHERE id = ?`).get(id);
  if (!row) return null;
  return toJob(db, row);
}

export function listAddonJobs(db: Database, sinceMs?: number): AddonJob[] {
  const rows = sinceMs
    ? db
        .query<JobRow, [number]>(
          `SELECT * FROM addon_jobs WHERE updated_at > ? ORDER BY created_at`,
        )
        .all(sinceMs)
    : db.query<JobRow, []>(`SELECT * FROM addon_jobs ORDER BY created_at`).all();
  return rows.map((row) => toJob(db, row));
}

export function deleteAddonJob(db: Database, id: string): void {
  db.run(`DELETE FROM addon_job_items WHERE job_id = ?`, [id]);
  db.run(`DELETE FROM addon_jobs WHERE id = ?`, [id]);
}

function toJob(db: Database, row: JobRow): AddonJob {
  const items = db
    .query<ItemRow, [string]>(`SELECT * FROM addon_job_items WHERE job_id = ? ORDER BY item_id`)
    .all(row.id);
  return {
    id: row.id,
    intent: row.intent as AddonJobIntent,
    artist: row.artist,
    album: row.album,
    state: row.state as AddonJobState,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items: items.map(toItem),
  };
}

function toItem(row: ItemRow): AddonJobItem {
  return {
    itemId: row.item_id,
    title: row.title,
    username: row.username,
    filename: row.filename,
    size: row.size,
    bitRateKbps: row.bit_rate_kbps ?? undefined,
    audioFormat: row.audio_format ?? undefined,
    state: row.state as AddonJobItemState,
    bytesTransferred: row.bytes_transferred ?? undefined,
    fileReady: row.file_ready === 1,
    updatedAt: row.updated_at,
  };
}

function touchJob(db: Database, jobId: string, now: number): void {
  db.run(`UPDATE addon_jobs SET updated_at = ? WHERE id = ?`, [now, jobId]);
}

const TRANSFER_ACTIVE_DOWNLOADING = new Set(['InProgress', 'Initializing']);
const TRANSFER_ACTIVE_QUEUED = new Set(['Requested', 'Queued, Locally', 'Queued, Remotely']);

/**
 * Live-sync non-terminal item states from a `getDownloads()` snapshot (called
 * on each GET /jobs). Completion/failure verdicts stay with the poller and the
 * fallback — this only reflects in-flight progress.
 */
export function syncItemStatesFromTransfers(
  db: Database,
  downloads: Array<{
    username: string;
    directories: Array<{
      files: Array<{ filename: string; state: string; bytesTransferred?: number }>;
    }>;
  }>,
): void {
  const now = Date.now();
  for (const group of downloads) {
    for (const dir of group.directories) {
      for (const file of dir.files) {
        const state = TRANSFER_ACTIVE_DOWNLOADING.has(file.state)
          ? 'downloading'
          : TRANSFER_ACTIVE_QUEUED.has(file.state)
            ? 'queued'
            : null;
        if (!state) continue;
        db.run(
          `UPDATE addon_job_items
           SET state = ?, bytes_transferred = ?, updated_at = ?
           WHERE username = ? AND filename = ? AND state IN ('queued', 'downloading')`,
          [state, file.bytesTransferred ?? null, now, group.username, file.filename],
        );
      }
    }
  }
}
