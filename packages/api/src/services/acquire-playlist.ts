import { basename } from 'node:path';
import type { PluginTrackEvent } from '@nicotind/core';
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

/**
 * Upsert one plugin track event into `acquire_job_tracks`, keyed on
 * (job_id, title): a re-emit for the same title (downloading → done, or a
 * retry replaying the list) updates the existing row in place — status
 * always, path only when the new event carries one (post-processing can
 * change the filename; a later title-only event must not erase a known
 * path). New titles append at MAX(position)+1, so positions reflect first
 * appearance order — the playlist order. Title-only events still insert a
 * row (empty path) so the resolver's title fallback has rows to walk;
 * gating the insert on `path` was the bug that silently disabled playlist
 * generation for spotdl.
 */
export function recordAcquireJobTrack(db: Database, jobId: string, track: PluginTrackEvent): void {
  const existing = db
    .query<{ position: number }, [string, string]>(
      `SELECT position FROM acquire_job_tracks WHERE job_id = ? AND title = ?`,
    )
    .get(jobId, track.title);
  if (existing) {
    if (track.path) {
      db.run(
        `UPDATE acquire_job_tracks SET status = ?, path = ? WHERE job_id = ? AND position = ?`,
        [track.status, track.path, jobId, existing.position],
      );
    } else {
      db.run(`UPDATE acquire_job_tracks SET status = ? WHERE job_id = ? AND position = ?`, [
        track.status,
        jobId,
        existing.position,
      ]);
    }
    return;
  }
  const next =
    db
      .query<{ next: number }, [string]>(
        `SELECT COALESCE(MAX(position), -1) + 1 AS next FROM acquire_job_tracks WHERE job_id = ?`,
      )
      .get(jobId)?.next ?? 0;
  db.run(
    `INSERT INTO acquire_job_tracks (job_id, position, title, status, path) VALUES (?, ?, ?, ?, ?)`,
    [jobId, next, track.title, track.status, track.path ?? ''],
  );
}

export interface ResolveAcquireJobTracksOptions {
  /**
   * When a row carries a `path`, prefer the library_song whose basename STEM
   * matches it (the organizer's per-album move keeps the basename, and the
   * lossless→Opus standardization only changes the extension). Falls back to
   * a title match within the same job's acquisitions when the stem isn't
   * found or the row is title-only (spotdl) — including stripping leading
   * "Artist - " segments off the event title. Both lookups are scoped to the
   * rows this job's `acquisitions` entries have resolved into
   * `library_songs.id` — never the whole library.
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
  // through acquisitions to scope to THIS job's URL only (`source_ref` is the
  // acquire URL — a peer with the same basename on a different URL, or an
  // slskd row whose source_ref is a peer username, can never collide).
  const landed = db
    .query<{ relative_path: string; song_id: string; title: string | null }, [string]>(
      `SELECT a.relative_path AS relative_path, s.id AS song_id, s.title AS title
         FROM acquisitions a
         JOIN library_songs s ON s.path = a.relative_path
        WHERE a.source_ref = ?`,
    )
    .all(jobUrl);
  if (landed.length === 0) return [];

  // Build lookup tables once. Basenames are keyed on the STEM (extension
  // stripped): the lossless→Opus standardization transcodes files in place
  // after the organizer move, so the plugin-emitted `track01.flac` must still
  // match the library's `track01.opus`.
  const byStem = new Map<string, { songId: string; title: string }[]>();
  const byTitle = new Map<string, { songId: string; title: string }[]>();
  for (const l of landed) {
    push(byStem, stem(basename(l.relative_path)), { songId: l.song_id, title: l.title ?? '' });
    push(byTitle, (l.title ?? '').toLowerCase(), { songId: l.song_id, title: l.title ?? '' });
  }

  // Title lookup with a shape fallback: spotdl logs `Artist - Title` while
  // library_songs.title is just the title, so after an exact miss we strip
  // leading " - " segments one at a time until something matches. Exact
  // matches always win — a library title that legitimately contains " - "
  // (band name in the title) is never shadowed by its stripped variant.
  const titleCandidates = (raw: string): { songId: string; title: string }[] => {
    const parts = raw.split(' - ');
    for (let skip = 0; skip < parts.length; skip++) {
      const candidate = parts.slice(skip).join(' - ').trim().toLowerCase();
      const found = byTitle.get(candidate);
      if (found) return found;
    }
    return [];
  };

  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const row of rows) {
    if (row.status !== 'done' && row.status !== 'skipped') continue;
    const stemMatch = row.path ? byStem.get(stem(row.path)) : undefined;
    const candidates = preferPath
      ? (stemMatch ?? titleCandidates(row.title))
      : titleCandidates(row.title).length > 0
        ? titleCandidates(row.title)
        : (stemMatch ?? []);
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

/** Lowercased basename with its extension stripped ("Track01.FLAC" → "track01"). */
function stem(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  return dot > 0 ? lower.slice(0, dot) : lower;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}
