import { moveSongGenreOverride } from './song-curation-carry.js';
import type { Database } from 'bun:sqlite';

/**
 * Carry a curator's song-scope genre override forward when the song's id
 * changes under it.
 *
 * why: `library_genre_overrides` (scope='song') keys on `library_songs.id` =
 * `sha1(path)`, so **any** move re-mints the id — a folder rename from an
 * artist-alias fix, an organizer consolidation, a lossless→Opus transcode. The
 * scanner then prunes the old row (`synced_at < …`) and every override row
 * pointing at the old id is instantly dead. There is no FK, so nothing errors
 * — the song is just silently tag-governed again, one bad retag from
 * reverting a decision a curator already made.
 *
 * Measured on prod: 290/953 (30%) song-scope overrides orphaned, 173 of them
 * curator `mode:'replace'` decisions — the exact ones a wrong tag would
 * revert. Where the file only *moved*, the tag mirror usually still carries
 * the value, so the loss is silent rather than visible: the row is gone, not
 * the genre, until the next bad tag has nothing left to stop it.
 *
 * This is exactly `repointPlaylistsBeforePrune`'s shape, one table over — see
 * `playlist-repoint.ts` for the fuller rationale on why recovery must happen
 * before the delete and why ambiguity is left to dangle rather than guessed.
 */

export interface GenreOverrideRepointResult {
  /** Override rows moved onto a surviving song. */
  repointed: number;
  /** Referenced songs with no confident replacement — these will dangle. */
  unmatched: number;
}

/** The identity of a song about to be deleted — all the match needs. */
export interface DoomedSong {
  id: string;
  title: string;
  artist: string;
  duration: number;
}

/**
 * Re-point one doomed song's override onto the surviving row for the same
 * recording. `syncedAt` scopes "surviving" to the rows the caller's scan just
 * persisted.
 *
 * Identity is `(title, artist, duration)`, and the match must be **unique** —
 * same contract as the playlist repoint. A wrong re-point silently attaches
 * one song's curated genre to a *different* song, which is worse than the
 * dangling row it replaces, so ambiguity is left to dangle.
 *
 * The per-song shape is what both delete sites share (#856): the full-scan
 * prune below, and the incremental `pruneAlbumOrphans`, which decides doom by
 * file existence rather than `synced_at` and therefore cannot use the
 * whole-library query — it runs at the download seam and deletes the row long
 * before any full scan could see it.
 */
export function repointGenreOverrideForSong(
  db: Database,
  song: DoomedSong,
  syncedAt: number,
): GenreOverrideRepointResult {
  const overridden = db
    .query<{ one: number }, [string]>(
      `SELECT 1 AS one FROM library_genre_overrides WHERE scope = 'song' AND key = ?`,
    )
    .get(song.id);
  if (!overridden) return { repointed: 0, unmatched: 0 };

  const survivors = db
    .query<{ id: string }, [number, string, string, string, number]>(
      // `id <> ?` because a caller that dooms by file existence can hand us a
      // row carrying this very syncedAt — it must never survive onto itself.
      `SELECT id FROM library_songs
        WHERE synced_at >= ? AND id <> ? AND title = ? AND artist = ? AND duration = ?
        LIMIT 2`,
    )
    .all(syncedAt, song.id, song.title, song.artist, song.duration);

  if (survivors.length !== 1) return { repointed: 0, unmatched: 1 };

  // This module's job ends at finding the survivor; the move itself is shared
  // with the transcode pass, which knows its mapping without searching for it.
  // The two had the same statements written out twice, verbatim.
  const moved = moveSongGenreOverride(db, song.id, survivors[0].id);
  return { repointed: moved ? 1 : 0, unmatched: 0 };
}

/**
 * Re-point song-scope genre override rows whose song is about to be pruned
 * onto the surviving row for the same recording.
 *
 * Call inside the prune transaction, before `DELETE FROM library_songs`,
 * alongside `repointPlaylistsBeforePrune`.
 */
export function repointGenreOverridesBeforePrune(
  db: Database,
  syncedAt: number,
): GenreOverrideRepointResult {
  const doomed = db
    .query<DoomedSong, [number]>(
      // Only songs a song-scope override actually references — the rest can
      // be pruned without any of this work.
      `SELECT s.id, s.title, s.artist, s.duration
         FROM library_songs s
        WHERE s.synced_at < ?
          AND EXISTS (
            SELECT 1 FROM library_genre_overrides o
             WHERE o.scope = 'song' AND o.key = s.id
          )`,
    )
    .all(syncedAt);

  const result: GenreOverrideRepointResult = { repointed: 0, unmatched: 0 };

  for (const song of doomed) {
    const one = repointGenreOverrideForSong(db, song, syncedAt);
    result.repointed += one.repointed;
    result.unmatched += one.unmatched;
  }

  return result;
}
