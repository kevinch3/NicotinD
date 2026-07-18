import { basename } from 'node:path';
import type { Database } from 'bun:sqlite';

/**
 * One row from `acquire_job_tracks` (plugin-emitted, in download order). The
 * post-ingest playlist step materializes a native playlist from this list.
 */
export interface AcquireJobTrackRow {
  position: number;
  title: string;
  status: string;
  path: string;
}

export interface ResolveAcquireJobTracksOptions {
  /**
   * When a row carries a `path`, prefer the library_song whose path ENDS with
   * that basename (the organizer's per-album move keeps the basename intact).
   * Falls back to a title-only match within the same job's acquisitions when
   * the basename isn't found — covers plugins that only emit a title (spotdl
   * today). Both lookups are scoped to the rows this job's `acquisitions`
   * entries have resolved into `library_songs.id` — never the whole library.
   */
  preferPath?: boolean;
}

/**
 * Resolve the per-track rows of a playlist-classified acquire job into a
 * deduplicated, ordered list of `library_songs.id`. Pure/testable given the
 * raw rows + a `db` for the lookup joins.
 *
 * Strategy:
 *   1. Pull every `(relative_path → song_id)` the job's `acquisitions` rows
 *      resolve into `library_songs` (filtered by `source_ref = jobUrl`).
 *   2. Walk the per-track rows in `position` order; for each row, find the
 *      matching song_id — basename match first (the path the plugin wrote
 *      survives the organizer's per-album move as the file's basename),
 *      title match within the same job's resolved paths as a fallback.
 *   3. Skip rows that didn't land (`status` not in `done`/`skipped`, or no
 *      matching song) — partial / failed downloads surface as a shorter
 *      playlist, matching the "X of N" warning on the job row.
 *   4. De-dup, preserving first occurrence (defensive against cross-track
 *      title reuse pointing at the same song_id).
 *
 * Returns just the song_id list. The caller (AcquireWatcher) wraps the result
 * in a `PlaylistService.create` call.
 */
export function resolveAcquireJobTracks(
  db: Database,
  jobId: string,
  jobUrl: string,
  rows: AcquireJobTrackRow[],
  opts: ResolveAcquireJobTracksOptions = {},
): string[] {
  const preferPath = opts.preferPath ?? true;

  // All `(relative_path → song_id)` the job has landed in the library, joined
  // through acquisitions to scope to THIS job's URL only (a peer with the same
  // basename on a different URL won't collide). The `method != 'slskd'` guard
  // is belt-and-braces — `source_ref` is the acquire URL, so slskd rows
  // (peer username) should never match — but it documents the intent and
  // keeps the lookup honest against any future cross-method acquisitions
  // that share a basename.
  const landed = db
    .query<
      { relative_path: string; song_id: string; title: string | null },
      [string]
    >(
      `SELECT a.relative_path AS relative_path, s.id AS song_id, s.title AS title
         FROM acquisitions a
         JOIN library_songs s ON s.path = a.relative_path
        WHERE a.source_ref = ?`,
    )
    .all(jobUrl);
  if (landed.length === 0) return [];

  // Build lookup tables once.
  const byBasename = new Map<string, { songId: string; title: string }[]>();
  const byTitle = new Map<string, { songId: string; title: string }[]>();
  for (const l of landed) {
    const base = basename(l.relative_path).toLowerCase();
    push(byBasename, base, { songId: l.song_id, title: l.title ?? '' });
    push(byTitle, (l.title ?? '').toLowerCase(), { songId: l.song_id, title: l.title ?? '' });
  }

  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const row of rows) {
    if (row.status !== 'done' && row.status !== 'skipped') continue;
    const candidates = preferPath
      ? (byBasename.get(row.path.toLowerCase()) ?? byTitle.get(row.title.toLowerCase()) ?? [])
      : (byTitle.get(row.title.toLowerCase()) ?? byBasename.get(row.path.toLowerCase()) ?? []);
    if (candidates.length === 0) continue;
    // Multiple candidates is only possible when the title fallback fires
    // against a job whose tracks share a title (e.g. an album with two
    // versions of "Intro"). Pick the first unused match so each row maps to a
    // distinct song — best-effort, defensive only.
    const picked = candidates.find((c) => !seen.has(c.songId));
    if (!picked) continue;
    seen.add(picked.songId);
    ordered.push(picked.songId);
  }
  return ordered;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}