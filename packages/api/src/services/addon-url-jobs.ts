import type { Database } from 'bun:sqlite';
import type { AcquireJob, AcquireAlbumDestination, TrackStatus } from '@nicotind/core';
import { parseAddonJobId } from './addons/job-poller.js';
import { jobDestinationAlbums } from './job-destinations.js';

/**
 * URL acquires that run **addon-side** (yt-dlp / spotdl / archive since the
 * phase-4 cutover) live only in the unified `acquisition_jobs` table — they
 * never get an `acquire_jobs` row, which belongs to the in-process URL engine.
 *
 * That left `GET /api/acquire/jobs` (a straight `acquire_jobs` read) blind to
 * them, so the web's link-intent card — which tracks its job by matching the
 * pasted URL against that list — never saw a job appear, kept rendering an
 * enabled **Get** button, and the user reasonably clicked it again. Each click
 * created another addon job and another feed row: the duplicate downloads, and
 * the "downloads list only fills in later" (the Downloads tab reads
 * `acquisition_jobs`, so it was the only surface that ever showed them).
 *
 * This module is the missing read side: a **projection**, never a second write
 * path, so there is no state to keep in sync — the poller stays the only writer.
 */

/** `acquisition_jobs.state` → the `AcquireJob` lifecycle the web renders. */
export function acquireStateFor(state: string, stage: string | null): AcquireJob['state'] {
  if (state === 'done') return 'done';
  if (state === 'failed' || state === 'superseded') return 'failed';
  // Anything still active is 'running' once bytes are moving, 'queued' before.
  return stage && stage !== 'queued' ? 'running' : 'queued';
}

/** `acquisition_jobs.stage` → `AcquireJob['stage']`, falling back to null. */
export function acquireStageFor(stage: string | null): AcquireJob['stage'] {
  const known: AcquireJob['stage'][] = [
    'queued',
    'downloading',
    'organizing',
    'scanning',
    'processing',
    'done',
    'error',
  ];
  return (known.find((s) => s === stage) as AcquireJob['stage']) ?? null;
}

function itemStatus(state: string): TrackStatus {
  if (state === 'scanned' || state === 'organized' || state === 'completed') return 'done';
  if (state === 'failed') return 'failed';
  if (state === 'unavailable') return 'skipped';
  return 'downloading';
}

interface UrlJobRow {
  id: string;
  method: string;
  state: string;
  stage: string | null;
  source_url: string | null;
  album_title: string | null;
  display_title: string | null;
  error: string | null;
  created_at: number;
}

const SELECT_URL_JOBS = `SELECT id, method, state, stage, source_url, album_title, display_title, error, created_at
   FROM acquisition_jobs
   WHERE kind = 'url' AND source_url IS NOT NULL
     AND source_ref LIKE 'addon:%'`;

/**
 * The in-flight addon URL job for `url`, if one exists. This is the idempotency
 * guard for `POST /api/acquire` on the addon path — the mirror of the
 * `acquire_jobs`-based one `AcquireWatcher.submit` has always had for the
 * in-process path. Without it, "one link = one download" simply did not hold
 * for yt-dlp/spotdl once they became addons.
 */
export function findInFlightAddonUrlJob(
  db: Database,
  url: string,
): { id: string; method: string } | null {
  return (
    db
      .query<{ id: string; method: string }, [string]>(
        `SELECT id, method FROM acquisition_jobs
         WHERE kind = 'url' AND state = 'active' AND source_url = ? AND source_ref LIKE 'addon:%'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(url) ?? null
  );
}

/** The addon id + addon-side job id backing one core URL job, or null. */
export function addonRefForUrlJob(
  db: Database,
  jobId: string,
): { addonId: string; addonJobId: string } | null {
  const row = db
    .query<{ method: string; source_ref: string | null }, [string]>(
      `SELECT method, source_ref FROM acquisition_jobs WHERE id = ? AND kind = 'url'`,
    )
    .get(jobId);
  if (!row) return null;
  const addonJobId = parseAddonJobId(row.source_ref, row.method);
  return addonJobId ? { addonId: row.method, addonJobId } : null;
}

/** The stored submit URL of one addon URL job (for Retry), or null. */
export function addonUrlJobUrl(db: Database, jobId: string): string | null {
  const row = db
    .query<{ source_url: string | null }, [string]>(
      `SELECT source_url FROM acquisition_jobs WHERE id = ? AND kind = 'url'`,
    )
    .get(jobId);
  return row?.source_url ?? null;
}

/** Project one addon URL job row into the `AcquireJob` shape the web consumes. */
function project(db: Database, row: UrlJobRow): AcquireJob {
  const counts = db
    .query<{ state: string; c: number }, [string]>(
      `SELECT state, COUNT(*) c FROM acquisition_job_items WHERE job_id = ? GROUP BY state`,
    )
    .all(row.id);
  const total = counts.reduce((a, r) => a + r.c, 0);
  const done = counts
    .filter((r) => r.state === 'completed' || r.state === 'organized' || r.state === 'scanned')
    .reduce((a, r) => a + r.c, 0);
  const tracks = db
    .query<{ track_title: string | null; state: string }, [string]>(
      `SELECT track_title, state FROM acquisition_job_items WHERE job_id = ? ORDER BY id`,
    )
    .all(row.id)
    .map((r) => ({ title: r.track_title ?? '', status: itemStatus(r.state) }));

  // Where the files actually landed, so "Open in Library" resolves — shared
  // with the unified feed, which names its cards from the same answer.
  const destinationAlbums: AcquireAlbumDestination[] = jobDestinationAlbums(db, row.id);
  const single = destinationAlbums.length === 1 ? destinationAlbums[0]! : null;

  return {
    id: row.id,
    backend: row.method,
    url: row.source_url!,
    // The addon's own display name wins: a playlist is named by its playlist
    // title, not by the album its tracks happen to be filed under.
    label: row.display_title ?? row.album_title,
    state: acquireStateFor(row.state, row.stage),
    stage: acquireStageFor(row.stage),
    storage_path: null,
    albumId: single?.albumId ?? null,
    albumArtist: single?.albumArtist ?? null,
    albumTitle: single?.albumTitle ?? null,
    destinationAlbums,
    progress: total > 0 ? { done, total } : null,
    tracks,
    // Playlist generation is an in-process-engine feature; an addon URL job
    // carries no playlist of its own yet, so these stay honest defaults rather
    // than pretending one is coming.
    isPlaylist: false,
    playlistId: null,
    error: row.error,
    // `AcquireJob.created_at` is unix **seconds** (`acquire_jobs` defaults to
    // `unixepoch()`); `acquisition_jobs.created_at` is `Date.now()` millis.
    // Converting here keeps one unit across both engines' jobs — mixing them
    // would sort every addon job to one end of the list and render its start
    // time in the year 57000.
    created_at: Math.floor(row.created_at / 1000),
  };
}

/** Every addon-run URL job, newest first, in the `AcquireJob` shape. */
export function listAddonUrlJobs(db: Database, limit = 50): AcquireJob[] {
  const rows = db
    .query<UrlJobRow, [number]>(`${SELECT_URL_JOBS} ORDER BY created_at DESC LIMIT ?`)
    .all(limit);
  return rows.map((row) => project(db, row));
}

/** One addon-run URL job by id, or null when it isn't one. */
export function getAddonUrlJob(db: Database, id: string): AcquireJob | null {
  const row = db.query<UrlJobRow, [string]>(`${SELECT_URL_JOBS} AND id = ?`).get(id);
  return row ? project(db, row) : null;
}
