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

/**
 * Re-point song-scope genre override rows whose song is about to be pruned
 * onto the surviving row for the same recording.
 *
 * Identity is `(title, artist, duration)`, and the match must be **unique** —
 * same contract as the playlist repoint. A wrong re-point silently attaches
 * one song's curated genre to a *different* song, which is worse than the
 * dangling row it replaces, so ambiguity is left to dangle.
 *
 * Call inside the prune transaction, before `DELETE FROM library_songs`,
 * alongside `repointPlaylistsBeforePrune`.
 */
export function repointGenreOverridesBeforePrune(
  db: Database,
  syncedAt: number,
): GenreOverrideRepointResult {
  const doomed = db
    .query<{ id: string; title: string; artist: string; duration: number }, [number]>(
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
    const survivors = db
      .query<{ id: string }, [number, string, string, number]>(
        `SELECT id FROM library_songs
          WHERE synced_at >= ? AND title = ? AND artist = ? AND duration = ?
          LIMIT 2`,
      )
      .all(syncedAt, song.title, song.artist, song.duration);

    if (survivors.length !== 1) {
      result.unmatched++;
      continue;
    }

    // OR IGNORE: the survivor may already carry its own song-scope override,
    // and (scope, key) is a primary key — a plain UPDATE would abort the
    // whole scan. Keeping the survivor's own row and dropping the doomed one
    // is the right outcome either way.
    const moved = db.run(
      `UPDATE OR IGNORE library_genre_overrides SET key = ? WHERE scope = 'song' AND key = ?`,
      [survivors[0].id, song.id],
    );
    result.repointed += Number(moved.changes ?? 0);
  }

  return result;
}
