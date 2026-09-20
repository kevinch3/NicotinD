import type { Database } from 'bun:sqlite';

/**
 * Carry a song's curation across an identity change, given the mapping.
 *
 * The sibling of `artist-curation-carry.ts`, and deliberately the same shape:
 * a **known** `fromId`/`toId`, no matching. That separation is the point —
 * `playlist-repoint.ts` and `genre-override-repoint.ts` exist to *find* the
 * successor of a row the scanner is about to prune, by `(title, artist,
 * duration)`; the transcode pass already knows it, because it chose the new
 * path itself. Mixing the two produced a hand-rolled copy of the same three
 * statements inside `library-transcode.ts`, one of them verbatim.
 *
 * Song ids are `sha1(path)`, so anything keyed on one is orphaned by a rename,
 * a move or a re-encode, and there are no foreign keys to catch it (`db.ts`
 * documents why: a cascade would delete listening history on a routine
 * rescan). Silence is the failure mode — #259 is the incident.
 *
 * → docs/library-path-conventions.md, docs/download-pipeline.md
 */

export interface SongCarry {
  fromId: string;
  toId: string;
  /**
   * Music-dir-relative paths. `acquisitions` keys on `relative_path`, not on
   * the song id, so provenance moves on a different key from everything else —
   * the same split `artist-curation-carry` makes for name-keyed rows. Omit to
   * leave provenance alone.
   */
  fromPath?: string;
  toPath?: string;
}

export interface SongCarryResult {
  /** Playlist entries re-pointed. */
  playlistRows: number;
  /** True when a song-scope genre override moved onto the new id. */
  genreOverrideMoved: boolean;
  /** True when a provenance row moved onto the new path. */
  acquisitionMoved: boolean;
}

/**
 * Move a song-scope genre override onto `toId`, dropping the stale row when it
 * cannot move.
 *
 * `OR IGNORE` because `(scope, key)` is a primary key and the destination may
 * already carry its own override — a plain `UPDATE` would abort the whole
 * enclosing transaction, which during a scan prune means losing the pass.
 * Zero changes therefore means one of two things, and both end the same way:
 * there was no override, or the destination already had one and keeping the
 * destination's own curation is the right outcome. Either way the source row
 * is dead weight, and `library_genre_overrides` is curator data deliberately
 * outside `ORPHAN_TABLES`, so nothing would ever sweep it (#856).
 */
export function moveSongGenreOverride(db: Database, fromId: string, toId: string): boolean {
  if (fromId === toId) return false;
  const moved = db.run(
    `UPDATE OR IGNORE library_genre_overrides SET key = ? WHERE scope = 'song' AND key = ?`,
    [toId, fromId],
  );
  if (Number(moved.changes ?? 0) > 0) return true;
  db.run(`DELETE FROM library_genre_overrides WHERE scope = 'song' AND key = ?`, [fromId]);
  return false;
}

/**
 * Carry playlist membership, the song-scope genre override and download
 * provenance onto a new song identity. No-op when the ids are equal.
 *
 * Caller supplies the transaction: every caller has other work to make atomic
 * with this, and nesting `db.transaction` would be the wrong boundary.
 */
export function carrySongCuration(db: Database, carry: SongCarry): SongCarryResult {
  const result: SongCarryResult = {
    playlistRows: 0,
    genreOverrideMoved: false,
    acquisitionMoved: false,
  };
  if (carry.fromId === carry.toId) return result;

  // OR IGNORE: `(playlist_id, song_id)` is a primary key and the destination
  // may already be in the same playlist.
  const playlists = db.run('UPDATE OR IGNORE playlist_songs SET song_id = ? WHERE song_id = ?', [
    carry.toId,
    carry.fromId,
  ]);
  result.playlistRows = Number(playlists.changes ?? 0);

  result.genreOverrideMoved = moveSongGenreOverride(db, carry.fromId, carry.toId);

  const { fromPath, toPath } = carry;
  if (fromPath && toPath && fromPath !== toPath) {
    // `relative_path` is the primary key, so a destination row already there
    // would collide and abort the transaction. It is also the *newer* record of
    // the two — a pre-existing copy at the destination path — so keeping it and
    // dropping the source is both safe and correct.
    const targetExists = db.query('SELECT 1 FROM acquisitions WHERE relative_path = ?').get(toPath);
    if (targetExists) {
      db.run('DELETE FROM acquisitions WHERE relative_path = ?', [fromPath]);
    } else {
      const moved = db.run('UPDATE acquisitions SET relative_path = ? WHERE relative_path = ?', [
        toPath,
        fromPath,
      ]);
      result.acquisitionMoved = Number(moved.changes ?? 0) > 0;
    }
  }

  return result;
}
