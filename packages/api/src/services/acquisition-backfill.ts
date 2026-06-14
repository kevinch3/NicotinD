/**
 * Best-effort backfill of acquisition provenance for library songs that predate
 * the `acquisitions` table (Phase 1 records new downloads going forward; this
 * fills in history). It joins `library_songs.path` against `completed_downloads`
 * — the reliable link the rest of the system already uses — and derives the
 * method from the recorded `username`:
 *   - `acquire:<jobId>` → look up `acquire_jobs.backend` (ytdlp/spotdl/archive)
 *   - any other username  → a Soulseek peer (`slskd`)
 * Songs with no `completed_downloads` row are left unrecorded (the UI shows them
 * as an unknown/unrecorded source rather than guessing).
 *
 * Idempotent and runs once at boot behind a `library_sync_state` marker. Mirrors
 * the untracked-backfill / artwork-backfill services.
 */
import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';
import type { AcquisitionMethod } from '@nicotind/core';
import { recordAcquisitionIfMissing } from './acquisition-store.js';

const log = createLogger('acquisition-backfill');

const FLAG_KEY = 'acquisitions_backfilled';

export interface AcquisitionBackfillResult {
  /** Songs that got a provenance row written. */
  matched: number;
  /** Songs with no completed_downloads link — left unrecorded. */
  unresolved: number;
}

function methodForBackend(backend: string): AcquisitionMethod {
  return backend === 'ytdlp' || backend === 'spotdl' || backend === 'archive'
    ? backend
    : 'unknown';
}

interface JoinRow {
  path: string;
  username: string;
  completed_at: number | null;
}

/**
 * Backfill acquisition rows for songs that don't have one yet. Pass
 * `{ force: true }` to ignore the run-once marker (used by tests).
 */
export function backfillAcquisitions(
  db: Database,
  opts: { force?: boolean } = {},
): AcquisitionBackfillResult {
  const result: AcquisitionBackfillResult = { matched: 0, unresolved: 0 };

  if (!opts.force) {
    const done = db
      .query<{ value: string }, [string]>(`SELECT value FROM library_sync_state WHERE key = ?`)
      .get(FLAG_KEY);
    if (done) return result;
  }

  // Cache acquire_jobs backend by job id so an `acquire:<id>` username resolves
  // to its real method without a per-row query.
  const backendByJob = new Map<string, string>();
  for (const j of db
    .query<{ id: string; backend: string }, []>(`SELECT id, backend FROM acquire_jobs`)
    .all()) {
    backendByJob.set(j.id, j.backend);
  }

  // Songs lacking a provenance row, joined to their download record by path.
  const rows = db
    .query<JoinRow, []>(
      `SELECT s.path AS path, cd.username AS username, cd.completed_at AS completed_at
         FROM library_songs s
         JOIN completed_downloads cd ON cd.relative_path = s.path
        WHERE NOT EXISTS (SELECT 1 FROM acquisitions a WHERE a.relative_path = s.path)`,
    )
    .all();

  for (const row of rows) {
    let method: AcquisitionMethod = 'slskd';
    let sourceRef: string | null = row.username;
    if (row.username.startsWith('acquire:')) {
      const backend = backendByJob.get(row.username.slice('acquire:'.length));
      method = backend ? methodForBackend(backend) : 'unknown';
      // The job's URL is long gone for pruned jobs; the job id is the best ref.
      sourceRef = row.username;
    }
    recordAcquisitionIfMissing(db, {
      relativePath: row.path,
      method,
      sourceRef,
      stage: 'done',
      startedAt: row.completed_at ?? 0,
      completedAt: row.completed_at,
    });
    result.matched++;
  }

  // Count songs that still have no provenance (no download link) for visibility.
  const unresolved = db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM library_songs s
        WHERE NOT EXISTS (SELECT 1 FROM acquisitions a WHERE a.relative_path = s.path)`,
    )
    .get();
  result.unresolved = unresolved?.n ?? 0;

  db.run(
    `INSERT OR REPLACE INTO library_sync_state (key, value, updated_at) VALUES (?, '1', ?)`,
    [FLAG_KEY, Date.now()],
  );
  log.info(result, 'Acquisition backfill complete');
  return result;
}
