import type { Database } from 'bun:sqlite';
import { normalizeTitle, titlesOverlap } from './album-hunter.service.js';

/**
 * Unified acquisition job store (`acquisition_jobs` + `acquisition_job_items`).
 *
 * Every download — slskd hunt, fallback recovery, direct grab, track search,
 * URL acquire — is wrapped in one job whose transfer↔job linkage is stored at
 * enqueue time, replacing the read-time `(username, directory)` string
 * matching that used to lose per-track fallbacks and alternate-peer pulls.
 * `album_jobs` stays as the cross-peer fallback engine's private table
 * (linked via album_job_id); `acquire_jobs` stays authoritative for URL jobs
 * (the mirror row shares its uuid).
 */

export type AcquisitionJobKind = 'album-hunt' | 'auto-acquire' | 'direct' | 'track-search' | 'url';
export type AcquisitionJobItemState =
  | 'downloading'
  | 'completed'
  | 'organized'
  | 'scanned'
  | 'failed'
  | 'unavailable';

export interface CreateJobInput {
  kind: AcquisitionJobKind;
  method: string;
  artistName?: string | null;
  albumTitle?: string | null;
  lidarrAlbumId?: number | null;
  releaseMbid?: string | null;
  artistMbid?: string | null;
  genres?: string[] | null;
  year?: number | null;
  canonicalTracks?: string[] | null;
  albumJobId?: number | null;
  sourceRef?: string | null;
  /** Peer the items were enqueued from (slskd). Per-file username overrides this. */
  username?: string | null;
  files?: Array<{
    filename: string;
    size?: number;
    trackTitle?: string | null;
    /** Multi-peer jobs (track search) enqueue different files from different peers. */
    username?: string;
  }>;
  /** Share an existing id (URL jobs mirror acquire_jobs.id). */
  id?: string;
}

export interface AcquisitionJobItem {
  id: number;
  trackTitle: string | null;
  username: string | null;
  filename: string | null;
  transferKey: string | null;
  attempts: number;
  state: AcquisitionJobItemState;
  relativePath: string | null;
  songId: string | null;
}

export interface AcquisitionJob {
  id: string;
  kind: AcquisitionJobKind;
  method: string;
  state: string;
  stage: string;
  artistName: string | null;
  albumTitle: string | null;
  lidarrAlbumId: number | null;
  releaseMbid: string | null;
  artistMbid: string | null;
  genres: string[] | null;
  year: number | null;
  canonicalTracks: string[] | null;
  albumJobId: number | null;
  sourceRef: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  items: AcquisitionJobItem[];
}

/**
 * The stored transfer identity: the EXACT enqueued username + remote filename.
 * Never normalized — backslashes and case must round-trip against what
 * slskd's getDownloads() echoes back (same contract as transfer_retries).
 */
export function transferKeyFor(username: string, filename: string): string {
  return `${username}::${filename}`;
}

/** Normalized basename for canonical-title matching (same shape album-fallback uses). */
function normalizeBasename(filename: string): string {
  const base = filename.replace(/\\/g, '/').split('/').pop() ?? filename;
  const noExt = base.slice(0, base.lastIndexOf('.') || base.length);
  return normalizeTitle(noExt);
}

/** Best-effort canonical title for an enqueued file, so the fallback can repoint it later. */
function matchTrackTitle(filename: string, canonicalTracks: string[]): string | null {
  const base = normalizeBasename(filename);
  return canonicalTracks.find((t) => titlesOverlap(normalizeTitle(t), base)) ?? null;
}

export function createJob(db: Database, input: CreateJobInput): string {
  const id = input.id ?? crypto.randomUUID();
  const now = Date.now();
  const insert = db.transaction(() => {
    db.run(
      `INSERT INTO acquisition_jobs
         (id, kind, method, artist_name, album_title, lidarr_album_id, release_mbid, artist_mbid,
          genres_json, year, canonical_tracks_json, album_job_id, source_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.kind,
        input.method,
        input.artistName ?? null,
        input.albumTitle ?? null,
        input.lidarrAlbumId ?? null,
        input.releaseMbid ?? null,
        input.artistMbid ?? null,
        input.genres?.length ? JSON.stringify(input.genres) : null,
        input.year ?? null,
        input.canonicalTracks?.length ? JSON.stringify(input.canonicalTracks) : null,
        input.albumJobId ?? null,
        input.sourceRef ?? null,
        now,
        now,
      ],
    );
    for (const file of input.files ?? []) {
      const username = file.username ?? input.username ?? null;
      const trackTitle =
        file.trackTitle ??
        (input.canonicalTracks?.length
          ? matchTrackTitle(file.filename, input.canonicalTracks)
          : null);
      db.run(
        `INSERT INTO acquisition_job_items
           (job_id, track_title, username, filename, transfer_key, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          id,
          trackTitle,
          username,
          file.filename,
          username ? transferKeyFor(username, file.filename) : null,
          now,
        ],
      );
    }
  });
  insert();
  return id;
}

interface JobRow {
  id: string;
  kind: AcquisitionJobKind;
  method: string;
  state: string;
  stage: string;
  artist_name: string | null;
  album_title: string | null;
  lidarr_album_id: number | null;
  release_mbid: string | null;
  artist_mbid: string | null;
  genres_json: string | null;
  year: number | null;
  canonical_tracks_json: string | null;
  album_job_id: number | null;
  source_ref: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

interface ItemRow {
  id: number;
  track_title: string | null;
  username: string | null;
  filename: string | null;
  transfer_key: string | null;
  attempts: number;
  state: AcquisitionJobItemState;
  relative_path: string | null;
  song_id: string | null;
}

function parseJsonArray(json: string | null): string[] | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

function mapItem(row: ItemRow): AcquisitionJobItem {
  return {
    id: row.id,
    trackTitle: row.track_title,
    username: row.username,
    filename: row.filename,
    transferKey: row.transfer_key,
    attempts: row.attempts,
    state: row.state,
    relativePath: row.relative_path,
    songId: row.song_id,
  };
}

function mapJob(row: JobRow, items: ItemRow[]): AcquisitionJob {
  return {
    id: row.id,
    kind: row.kind,
    method: row.method,
    state: row.state,
    stage: row.stage,
    artistName: row.artist_name,
    albumTitle: row.album_title,
    lidarrAlbumId: row.lidarr_album_id,
    releaseMbid: row.release_mbid,
    artistMbid: row.artist_mbid,
    genres: parseJsonArray(row.genres_json),
    year: row.year,
    canonicalTracks: parseJsonArray(row.canonical_tracks_json),
    albumJobId: row.album_job_id,
    sourceRef: row.source_ref,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items: items.map(mapItem),
  };
}

export function getJob(db: Database, id: string): AcquisitionJob | null {
  const row = db.query<JobRow, [string]>(`SELECT * FROM acquisition_jobs WHERE id = ?`).get(id);
  if (!row) return null;
  const items = db
    .query<ItemRow, [string]>(`SELECT * FROM acquisition_job_items WHERE job_id = ? ORDER BY id`)
    .all(id);
  return mapJob(row, items);
}

export interface TransferJobMeta {
  jobId: string;
  kind: AcquisitionJobKind;
  artistName: string | null;
  albumTitle: string | null;
  lidarrAlbumId: number | null;
  genres: string[] | null;
  year: number | null;
  canonicalTracks: string[] | null;
}

/** States that can still change peer/outcome — everything but a delivered file. */
const REPOINTABLE_STATES = `('downloading', 'failed', 'unavailable')`;
/** States still waiting on pipeline progress (used by the idle valve). */
const NON_TERMINAL_STATES = `('downloading', 'completed', 'organized')`;

/** Idle valve: a job whose non-terminal items saw no activity for this long is closed out. */
const ITEM_IDLE_VALVE_MS = 24 * 3_600_000;
/** Finished jobs older than this are pruned (mirrors AcquireWatcher's 7-day sweep). */
const FINISHED_JOB_TTL_MS = 7 * 24 * 3_600_000;

export function markItemCompleted(db: Database, transferKey: string): void {
  db.run(
    `UPDATE acquisition_job_items SET state = 'completed', updated_at = ?
     WHERE transfer_key = ? AND state IN ${NON_TERMINAL_STATES}`,
    [Date.now(), transferKey],
  );
}

export function markItemOrganized(db: Database, transferKey: string, relativePath: string): void {
  db.run(
    `UPDATE acquisition_job_items SET state = 'organized', relative_path = ?, updated_at = ?
     WHERE transfer_key = ?`,
    [relativePath, Date.now(), transferKey],
  );
}

/** Attach scanned song ids to items by their post-organize relative path. */
export function markItemsScanned(db: Database, pathToSongId: Map<string, string>): void {
  const now = Date.now();
  for (const [relativePath, songId] of pathToSongId) {
    db.run(
      `UPDATE acquisition_job_items SET state = 'scanned', song_id = ?, updated_at = ?
       WHERE relative_path = ? AND state != 'scanned'`,
      [songId, now, relativePath],
    );
  }
}

/**
 * Fallback re-enqueue: point the matching still-missing item at a new peer.
 * Restricted to non-completed items so an overlapping title can never
 * mislabel a delivered file. Returns false when nothing safe matched.
 */
export function repointItem(
  db: Database,
  jobId: string,
  trackTitle: string,
  username: string,
  filename: string,
): boolean {
  const candidates = db
    .query<
      { id: number; track_title: string | null },
      [string]
    >(`SELECT id, track_title FROM acquisition_job_items
       WHERE job_id = ? AND state IN ${REPOINTABLE_STATES}`)
    .all(jobId);
  const wanted = normalizeTitle(trackTitle);
  const match = candidates.find(
    (c) => c.track_title && titlesOverlap(normalizeTitle(c.track_title), wanted),
  );
  if (!match) return false;
  db.run(
    `UPDATE acquisition_job_items
     SET username = ?, filename = ?, transfer_key = ?, state = 'downloading',
         attempts = attempts + 1, updated_at = ?
     WHERE id = ?`,
    [username, filename, transferKeyFor(username, filename), Date.now(), match.id],
  );
  return true;
}

/** The unified job that owns a fallback `album_jobs` row, if one was recorded. */
export function acquisitionJobIdForAlbumJob(db: Database, albumJobId: number): string | null {
  const row = db
    .query<
      { id: string },
      [number]
    >(`SELECT id FROM acquisition_jobs WHERE album_job_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(albumJobId);
  return row?.id ?? null;
}

/**
 * Repoint the matching item, or attach a fresh one when no safe match exists
 * (defensive: a fallback wave for a track the job never itemised must still
 * be linked, not lost).
 */
export function repointOrAttachItem(
  db: Database,
  jobId: string,
  trackTitle: string,
  username: string,
  filename: string,
): void {
  if (repointItem(db, jobId, trackTitle, username, filename)) return;
  db.run(
    `INSERT INTO acquisition_job_items
       (job_id, track_title, username, filename, transfer_key, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [jobId, trackTitle, username, filename, transferKeyFor(username, filename), Date.now()],
  );
}

/**
 * Give up on a job's still-pending items (fallback exhausted / manual close):
 * they become `unavailable` so the job can finish as an honest partial
 * ("11 of 13 · 2 unavailable") instead of hanging on tracks nobody has.
 */
export function markMissingItemsUnavailable(db: Database, jobId: string): void {
  db.run(
    `UPDATE acquisition_job_items SET state = 'unavailable', updated_at = ?
     WHERE job_id = ? AND state IN ${NON_TERMINAL_STATES}`,
    [Date.now(), jobId],
  );
}

/**
 * Derive the job's stage/state purely from its item states (+ the landed flag
 * of scanned songs). Idempotent — safe under any watcher/scan/graduate
 * interleaving, no stored counters to corrupt.
 */
export function recomputeStage(db: Database, jobId: string): string | null {
  const job = db
    .query<
      { state: string; stage: string },
      [string]
    >(`SELECT state, stage FROM acquisition_jobs WHERE id = ?`)
    .get(jobId);
  if (!job) return null;
  // Terminal job states are never reopened by a recompute.
  if (job.state === 'superseded') return job.stage;

  const counts = new Map<string, number>();
  for (const row of db
    .query<
      { state: string; c: number },
      [string]
    >(`SELECT state, COUNT(*) c FROM acquisition_job_items WHERE job_id = ? GROUP BY state`)
    .all(jobId)) {
    counts.set(row.state, row.c);
  }
  if (counts.size === 0) return job.stage;

  let stage: string;
  let state: string;
  if (counts.has('downloading')) {
    stage = 'downloading';
    state = 'active';
  } else if (counts.has('completed')) {
    stage = 'organizing';
    state = 'active';
  } else if (counts.has('organized')) {
    stage = 'scanning';
    state = 'active';
  } else if ((counts.get('scanned') ?? 0) === 0) {
    stage = 'error';
    state = 'failed';
  } else {
    const pendingLanding = db
      .query<{ c: number }, [string]>(
        `SELECT COUNT(*) c FROM acquisition_job_items i
         JOIN library_songs s ON s.id = i.song_id
         WHERE i.job_id = ? AND i.state = 'scanned' AND s.landed_at IS NULL`,
      )
      .get(jobId);
    if ((pendingLanding?.c ?? 0) > 0) {
      stage = 'processing';
      state = 'active';
    } else {
      stage = 'done';
      state = 'done';
    }
  }
  db.run(`UPDATE acquisition_jobs SET state = ?, stage = ?, updated_at = ? WHERE id = ?`, [
    state,
    stage,
    Date.now(),
    jobId,
  ]);
  return stage;
}

/** Mirror of the hunt route's `?replace=true`: retire prior active jobs for the album. */
export function supersedeActiveJobs(
  db: Database,
  target: { lidarrAlbumId: number },
): void {
  db.run(
    `UPDATE acquisition_jobs SET state = 'superseded', updated_at = ?
     WHERE state = 'active' AND lidarr_album_id = ?`,
    [Date.now(), target.lidarrAlbumId],
  );
}

/**
 * Startup + periodic hygiene (same contract AcquireWatcher gives acquire_jobs):
 * fail items idle past the 24h valve so a restart or vanished transfer can
 * never strand a job "downloading" forever, then prune finished jobs.
 */
export function reconcileOnBoot(db: Database, now = Date.now()): void {
  const staleJobIds = db
    .query<{ job_id: string }, [number]>(
      `SELECT DISTINCT job_id FROM acquisition_job_items
       WHERE state IN ${NON_TERMINAL_STATES} AND updated_at < ?`,
    )
    .all(now - ITEM_IDLE_VALVE_MS)
    .map((r) => r.job_id);
  if (staleJobIds.length) {
    db.run(
      `UPDATE acquisition_job_items SET state = 'failed', updated_at = ?
       WHERE state IN ${NON_TERMINAL_STATES} AND updated_at < ?`,
      [now, now - ITEM_IDLE_VALVE_MS],
    );
    for (const jobId of staleJobIds) recomputeStage(db, jobId);
  }

  // Prune keys on updated_at (when the job last moved), not created_at, so a
  // job the valve just closed stays visible for its full TTL. Explicit item
  // delete: FK cascade needs PRAGMA foreign_keys, which we don't rely on.
  const prune = db.transaction(() => {
    db.run(
      `DELETE FROM acquisition_job_items WHERE job_id IN (
         SELECT id FROM acquisition_jobs
         WHERE state IN ('done', 'failed', 'superseded') AND updated_at < ?
       )`,
      [now - FINISHED_JOB_TTL_MS],
    );
    db.run(
      `DELETE FROM acquisition_jobs
       WHERE state IN ('done', 'failed', 'superseded') AND updated_at < ?`,
      [now - FINISHED_JOB_TTL_MS],
    );
  });
  prune();
}

/**
 * Resolve the job a transfer belongs to by its exact stored key — the
 * replacement for every read-time folder-string matcher.
 */
export function jobMetaForTransfer(
  db: Database,
  username: string,
  filename: string,
): TransferJobMeta | null {
  const row = db
    .query<
      JobRow,
      [string]
    >(`SELECT j.* FROM acquisition_job_items i JOIN acquisition_jobs j ON j.id = i.job_id
       WHERE i.transfer_key = ? ORDER BY i.updated_at DESC LIMIT 1`)
    .get(transferKeyFor(username, filename));
  if (!row) return null;
  return {
    jobId: row.id,
    kind: row.kind,
    artistName: row.artist_name,
    albumTitle: row.album_title,
    lidarrAlbumId: row.lidarr_album_id,
    genres: parseJsonArray(row.genres_json),
    year: row.year,
    canonicalTracks: parseJsonArray(row.canonical_tracks_json),
  };
}
