import type { Database } from 'bun:sqlite';
import type { JwtPayload } from '@nicotind/core';
import { SINGLES_DIR_RE } from './album-reconcile.js';
import { recordAudit } from './audit-log.js';
import type { TrackGetAnswer, TrackGetRequest } from './track-get.service.js';

export interface ImproveSongDeps {
  db: Database;
  /** The runtime acquisition kill-switch; an agent cannot lift it. */
  isAcquisitionEnabled: () => boolean;
  requestTrackGet: (req: TrackGetRequest) => TrackGetAnswer;
}

export type ImproveSongResult =
  | { ok: true; outcome: 'started' | 'in-flight'; jobId: string }
  | {
      ok: false;
      reason:
        'song-not-found' | 'not-in-album-folder' | 'acquisition-disabled' | 'source-unavailable';
      error: string;
    };

/**
 * The `<Artist>/<Album>` folder a song's file sits in, which is where a better
 * copy has to land for the folder reconcile to compare the two. Null for a file
 * anywhere else: a loose single (`<Artist>/Singles`, which the reconcile never
 * collapses), or a layout the organizer did not make and will not file into.
 * Taken from the path, not the album row: an override or a split renames the
 * row while the file stays where it is.
 */
export function albumFolderOf(relPath: string): { artist: string; album: string } | null {
  const parts = relPath.split('/');
  if (parts.length !== 3) return null;
  const [artist, album] = parts as [string, string, string];
  if (!artist.trim() || !album.trim() || SINGLES_DIR_RE.test(album)) return null;
  return { artist, album };
}

/** A folder named after a compilation hunts nothing; search by the song's own credit then. */
const COMPILATION_FOLDER = /^various artists$/i;

/**
 * "Get a better copy" of one song (#2032): a track Get named after the song's
 * own `<Artist>/<Album>` folder (`albumFolderOf`), so the copy lands beside it.
 *
 * Nothing here judges quality. The organizer's folder reconcile already keeps
 * one best copy per track (lossless, then bitrate) and deletes the other, and
 * since #2032 the poller carries a replaced song's likes, playlists, plays and
 * curation onto the copy that won. So the answer is only whether a hunt was
 * started; whether it improved anything is read off the job, like any Get.
 * A song outside such a folder is refused rather than duplicated.
 *
 * One hunt per song at a time: an active track Get for the same artist, title
 * and album is reported as `in-flight` rather than queued twice.
 */
export function requestBetterCopy(
  deps: ImproveSongDeps,
  songId: string,
  audit: { actor: Pick<JwtPayload, 'sub' | 'username'>; via?: string },
): ImproveSongResult {
  const { db } = deps;
  const song = db
    .query<{ title: string; artist: string; path: string }, [string]>(
      'SELECT title, artist, path FROM library_songs WHERE id = ?',
    )
    .get(songId);
  if (!song) return { ok: false, reason: 'song-not-found', error: 'Song not found' };
  const folder = albumFolderOf(song.path);
  if (!folder) {
    return {
      ok: false,
      reason: 'not-in-album-folder',
      error:
        'This song is not in an Artist/Album folder (a loose single, or a layout the organizer does not file into), so a better copy could not replace it in place',
    };
  }
  if (!deps.isAcquisitionEnabled()) {
    return {
      ok: false,
      reason: 'acquisition-disabled',
      error: 'Acquisition is disabled on this server',
    };
  }

  const album = folder.album;
  const artist = COMPILATION_FOLDER.test(folder.artist) ? song.artist : folder.artist;
  const active = db
    .query<{ id: string }, [string, string, string]>(
      `SELECT id FROM acquisition_jobs
        WHERE state = 'active' AND kind = 'track-search' AND cancel_requested_at IS NULL
          AND artist_name = ? COLLATE NOCASE
          AND display_title = ? COLLATE NOCASE
          AND COALESCE(album_title, '') = ? COLLATE NOCASE
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .get(artist, song.title, album);

  let result: ImproveSongResult;
  if (active) {
    result = { ok: true, outcome: 'in-flight', jobId: active.id };
  } else {
    const answer = deps.requestTrackGet({
      artist,
      title: song.title,
      album,
      userId: audit.actor.sub,
    });
    result =
      answer.status === 'accepted'
        ? { ok: true, outcome: 'started', jobId: answer.jobId }
        : {
            ok: false,
            reason: 'source-unavailable',
            error: 'No acquisition addon registered',
          };
  }

  recordAudit(db, audit.actor, 'song.improve', {
    targetKind: 'song',
    targetId: songId,
    detail: `${song.artist} — ${song.title}: ${result.ok ? `${result.outcome} job=${result.jobId}` : result.reason}${
      audit.via ? ` (${audit.via})` : ''
    }`,
  });
  return result;
}
