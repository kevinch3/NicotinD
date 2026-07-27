import type { Database } from 'bun:sqlite';

/**
 * Carry playlist membership forward when a song's id changes under it.
 *
 * why: song ids are `sha1(path)`, so **any** move re-mints the id — a folder
 * rename from an artist-alias fix, an organizer consolidation, a repair script.
 * The scanner then prunes the old row (`synced_at < …`) and inserts a new one,
 * and every `playlist_songs` row pointing at the old id is instantly dead.
 * There is no FK, and playlist reads `INNER JOIN library_songs`, so the entry
 * doesn't error — **the playlist just silently renders one song shorter**.
 *
 * Measured on prod: 17 dangling rows across 11 user playlists (1-3 each), plus
 * 62 in curated shelves. The curated ones self-heal on the weekly refresh; the
 * user ones never do.
 *
 * The transcode path already does exactly this (`library-transcode.ts` re-points
 * `playlist_songs` when lossless→opus changes the id) — the scanner prune was
 * simply the one id-changing path that didn't.
 *
 * **Recovery must happen before the delete.** `playlist_songs` stores only
 * `song_id`, so once the row is gone there is nothing left to identify what the
 * entry was — no title, no path. That is why this is preventive and cannot be a
 * repair script.
 */

export interface RepointResult {
  /** Playlist rows moved onto a surviving song. */
  repointed: number;
  /** Referenced songs with no confident replacement — these will dangle. */
  unmatched: number;
}

/**
 * Re-point playlist rows whose song is about to be pruned onto the surviving
 * row for the same recording.
 *
 * Identity is `(title, artist, duration)`, and the match must be **unique**. A
 * wrong re-point silently puts a different song in someone's playlist, which is
 * worse than the dangling entry it replaces — so ambiguity is left to dangle.
 * Duration is what makes the triple safe: same title + artist across two
 * different recordings (a live cut, a remix) almost always differ in length.
 *
 * Call inside the prune transaction, before `DELETE FROM library_songs`.
 */
export function repointPlaylistsBeforePrune(db: Database, syncedAt: number): RepointResult {
  const doomed = db
    .query<{ id: string; title: string; artist: string; duration: number }, [number]>(
      // Only songs a playlist actually references — the rest can be pruned
      // without any of this work.
      `SELECT s.id, s.title, s.artist, s.duration
         FROM library_songs s
        WHERE s.synced_at < ?
          AND EXISTS (SELECT 1 FROM playlist_songs p WHERE p.song_id = s.id)`,
    )
    .all(syncedAt);

  const result: RepointResult = { repointed: 0, unmatched: 0 };

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

    // OR IGNORE: the playlist may already contain the surviving song, and the
    // (playlist_id, song_id) uniqueness would otherwise abort the whole scan.
    // Dropping the duplicate entry is the right outcome either way.
    const moved = db.run(`UPDATE OR IGNORE playlist_songs SET song_id = ? WHERE song_id = ?`, [
      survivors[0].id,
      song.id,
    ]);
    result.repointed += Number(moved.changes ?? 0);
  }

  return result;
}

/** Playlist rows whose song no longer exists — the damage already done. */
export function countDanglingPlaylistRows(db: Database): number {
  return Number(
    (
      db
        .query<{ n: number }, []>(
          `SELECT COUNT(*) AS n FROM playlist_songs p
            WHERE NOT EXISTS (SELECT 1 FROM library_songs s WHERE s.id = p.song_id)`,
        )
        .get() ?? { n: 0 }
    ).n,
  );
}
