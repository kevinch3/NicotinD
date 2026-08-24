import type { Database } from 'bun:sqlite';
import type { PlaylistService } from './playlist.service.js';

/**
 * Playlist-from-acquisition on the **addon** lane (issue #587).
 *
 * The original design (docs/playlist-from-acquisition.md) ran entirely inside
 * `AcquireWatcher`/`acquire_jobs`, the in-process URL engine — and depended on
 * matching a stdout-parsed title back to a scanned song by path-stem or a
 * `"Artist - "`-stripped title, because that engine's `acquire_job_tracks`
 * rows had no direct link to the library. Since the addon split, no in-process
 * resolve plugin has fed that engine (`registerBuiltinPlugins` registers
 * none), so it is dead code in production — every Spotify/YouTube/archive URL
 * routes through `resolveAddonForUrl` instead, and that path never generated
 * a playlist at all (`addon-url-jobs.ts` hardcoded `isPlaylist: false`).
 *
 * This is the addon-native equivalent, and it is simpler than the legacy path
 * by construction: `acquisition_job_items.song_id` is already populated
 * directly by `markItemsScanned` once a file lands and scans, so there is no
 * title/path matching to do — just read the ordered, landed song ids.
 *
 * **Ordering**: `acquisition_job_items` carries no explicit position column.
 * `mirrorItems` (job-poller.ts) preserves order by construction — a new item
 * is INSERTed (autoincrement `id`), an already-seen one only UPDATEd in
 * place — so `ORDER BY id` is the item-order convention this codebase already
 * relies on elsewhere (`acquisition-job-store.ts`'s own reads, `addon-url-
 * jobs.ts`'s `tracks` projection). The addon protocol guarantees a new item
 * enters `job.items` the first time it is reported, in the order the
 * downloader reports it — exact for yt-dlp (`Downloading item N of M`,
 * strictly sequential), completion order for spotdl (its default `--threads
 * 2` means two tracks can finish out of submission order — a documented,
 * accepted imprecision, not a correctness bug: the playlist is still every
 * landed track, in an order that can differ from the source by at most a
 * couple of adjacent positions).
 *
 * **Retry continuity**: a retry submits a brand-new `acquisition_jobs` row
 * (`startAddonUrlJob` runs the same create path as a fresh submit — there is
 * no "resume this job id" for an addon-run URL job), so unlike the legacy
 * engine this cannot look up "my own prior playlist_id" on retry. Continuity
 * is instead resolved by `(source_url, user_id)`: the most recent *other* row
 * for the same link and submitter that already generated a playlist. A
 * different user submitting the same link gets their own copy (matches the
 * existing private-playlists model); a deleted prior playlist (the lookup
 * finding an id `PlaylistService.update` refuses to own) falls through to a
 * fresh one rather than throwing.
 */

interface PlaylistJobRow {
  user_id: string | null;
  is_playlist: number;
  display_title: string | null;
  source_url: string | null;
  playlist_id: string | null;
}

/**
 * Generate or refresh the native playlist for a playlist-classified addon URL
 * job. Safe to call more than once for the same job (idempotent — refreshes
 * in place rather than duplicating) and a no-op for any job that isn't a
 * playlist, has no submitter, or has landed nothing yet.
 */
export function materializeAddonPlaylist(
  db: Database,
  playlists: PlaylistService,
  jobId: string,
): void {
  const job = db
    .query<PlaylistJobRow, [string]>(
      `SELECT user_id, is_playlist, display_title, source_url, playlist_id
       FROM acquisition_jobs WHERE id = ?`,
    )
    .get(jobId);
  if (!job || !job.is_playlist || !job.user_id) return;

  const songIds = db
    .query<{ song_id: string }, [string]>(
      `SELECT song_id FROM acquisition_job_items
       WHERE job_id = ? AND song_id IS NOT NULL ORDER BY id ASC`,
    )
    .all(jobId)
    .map((r) => r.song_id);
  // Never a success: an empty playlist is worse than no playlist, and a
  // job that landed nothing already reports that on the card itself.
  if (songIds.length === 0) return;

  const userId = job.user_id;
  const name = job.display_title?.trim() || 'Imported playlist';

  // This row's own prior write (a re-fire before the addon job is released)
  // takes priority — it needs no cross-row lookup and is always safe to trust
  // since it can only be a playlist this same materialize call created.
  let targetId = job.playlist_id;
  if (!targetId && job.source_url) {
    const prior = db
      .query<{ playlist_id: string }, [string, string, string]>(
        `SELECT playlist_id FROM acquisition_jobs
         WHERE source_url = ? AND user_id = ? AND playlist_id IS NOT NULL AND id != ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(job.source_url, userId, jobId);
    targetId = prior?.playlist_id ?? null;
  }

  // Verify ownership with the SAME predicate `PlaylistService.update` gates
  // on (`kind='user' AND user_id=?`) before touching anything — `.get()`'s own
  // visibility rule additionally admits any `kind='curated'` row, which is the
  // wrong check here: it would let a curated playlist's `playlist_songs` be
  // wiped by the delete below before discovering `update()` refuses to write
  // to it.
  const owned = targetId
    ? db
        .query<{ id: string }, [string, string]>(
          `SELECT id FROM playlists WHERE id = ? AND user_id = ? AND kind = 'user'`,
        )
        .get(targetId, userId)
    : null;

  if (owned) {
    db.run(`DELETE FROM playlist_songs WHERE playlist_id = ?`, [targetId]);
    // Refresh: name may have changed (an addon can resolve a better title
    // after the first tick), songs are a full replace in the new order.
    playlists.update(userId, targetId!, { name, add: songIds });
  } else {
    targetId = playlists.create(userId, { name, songIds }).id;
  }

  db.run(`UPDATE acquisition_jobs SET playlist_id = ?, updated_at = ? WHERE id = ?`, [
    targetId,
    Date.now(),
    jobId,
  ]);
}
