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

/**
 * Song-id-keyed tables this carry moves, and the ones it deliberately does not.
 *
 * Two lists rather than one, both consulted by `check:song-carry-coverage`,
 * which enumerates every song-id-shaped column **from the live schema** and
 * fails on any appearing in neither. A table added later cannot quietly fall
 * out of the migration — the failure mode this module exists for, since with no
 * foreign keys an uncarried table produces no error, just rows that stop
 * matching.
 *
 * This is **not** `ORPHAN_TABLES`, and driving off that list would be exactly
 * backwards. That one names tables safe to *delete from* because they are
 * regenerable; a carry wants the opposite — the ones unsafe to lose.
 * `playlist_songs` and `library_lyrics` are absent from it on purpose.
 */
export interface SongCarryTable {
  table: string;
  /** The column holding the song id. */
  column: string;
  /** Why it must move, or why it must not. Read by whoever adds the next table. */
  why: string;
}

export const SONG_CARRY_TABLES: readonly SongCarryTable[] = [
  {
    table: 'playlist_songs',
    column: 'song_id',
    why: 'membership a user chose; reads INNER JOIN, so a dangling row silently shortens the playlist (#259)',
  },
  {
    table: 'library_lyrics',
    column: 'song_id',
    why: 'network-sourced and hand-corrected; outside ORPHAN_TABLES, so nothing sweeps it and nothing rebuilds it. Synced LRC offsets exist only here',
  },
  {
    table: 'recommendation_feedback',
    column: 'song_id',
    why: '"never recommend this" is a user decision; losing it silently resets an exclusion they would have to make again',
  },
  {
    table: 'library_embeddings',
    column: 'song_id',
    why: 'regenerable, but ~46% of the database by bytes and the sidecar must re-embed every row',
  },
  {
    table: 'library_song_descriptors',
    column: 'song_id',
    why: 'regenerable at ~5s each, which is hours across a whole-library pass',
  },
];

/** Deliberately not carried. Each entry is a decision, not an oversight. */
export const SONG_CARRY_EXEMPT: readonly SongCarryTable[] = [
  {
    table: 'library_song_artists',
    column: 'song_id',
    why: 'rebuilt from the file tags by the scan; carrying it would fight the rebuild',
  },
  {
    table: 'library_song_genres',
    column: 'song_id',
    why: 'rebuilt from the file tags by the scan. The curator OVERRIDE is a different table and is carried',
  },
  {
    table: 'library_song_analysis_failures',
    column: 'song_id',
    why: 'a ledger of attempts against a file no longer at that id; meaningless once moved',
  },
  {
    table: 'library_pending_tag_writes',
    column: 'song_id',
    why: 'holds field names, not values: the flush mirrors the song row, and a re-minted row was rebuilt from file tags that never got them, so the tasks re-run and re-queue on the new id. The flush drops rows whose song is gone (#1311)',
  },
  {
    table: 'play_events',
    column: 'song_id',
    why: 'defended by snapshot instead: title/artist/album are copied onto the event precisely so history survives an id re-mint (db.ts)',
  },
  {
    table: 'radio_poll_scenarios',
    column: 'seed_song_id',
    why: 'a recorded measurement; re-pointing it would rewrite what was actually asked',
  },
  {
    table: 'radio_poll_votes',
    column: 'candidate_song_id',
    why: 'a recorded measurement; re-pointing it would rewrite what was actually voted on',
  },
  {
    table: 'acquisition_job_items',
    column: 'song_id',
    why: 'a historical record of one job; the live provenance row is `acquisitions`, which IS carried, on its own path key',
  },
  {
    table: 'library_song_provenance',
    column: 'song_path',
    why: 'path-keyed, not id-keyed, and superseded by `acquisitions` for anything live',
  },
];

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
  /** Rows moved, per table. Tables with nothing to move are omitted. */
  moved: Record<string, number>;
  /**
   * Rows dropped because the destination already had its own, per table.
   * Non-zero is normal — it means the new id was already curated — but a
   * surprising count is worth looking at.
   */
  dropped: Record<string, number>;
  /** Playlist entries re-pointed. Kept for callers that read it by name. */
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
 * Move every row keyed on `fromId` in `entry.table` onto `toId`, then drop
 * whatever could not move.
 *
 * One policy covers all of them, and it is the right one in each case:
 * `OR IGNORE` because a unique or primary key may already hold a row for the
 * destination, and a plain `UPDATE` would abort the caller's whole transaction.
 * A row that could not move means the destination is already curated, so
 * keeping the destination's own data and dropping the source is correct rather
 * than merely safe. The leftover is deleted explicitly — these tables sit
 * outside `ORPHAN_TABLES` precisely because nothing should sweep them, so an
 * abandoned row would live forever.
 */
function moveRows(
  db: Database,
  entry: SongCarryTable,
  fromId: string,
  toId: string,
): { moved: number; dropped: number } {
  const upd = db.run(
    `UPDATE OR IGNORE ${entry.table} SET ${entry.column} = ? WHERE ${entry.column} = ?`,
    [toId, fromId],
  );
  const moved = Number(upd.changes ?? 0);
  const del = db.run(`DELETE FROM ${entry.table} WHERE ${entry.column} = ?`, [fromId]);
  return { moved, dropped: Number(del.changes ?? 0) };
}

/**
 * Carry every registered song-keyed table, the song-scope genre override and
 * download provenance onto a new song identity. No-op when the ids are equal.
 *
 * Caller supplies the transaction: every caller has other work to make atomic
 * with this, and nesting `db.transaction` would be the wrong boundary.
 */
export function carrySongCuration(db: Database, carry: SongCarry): SongCarryResult {
  const result: SongCarryResult = {
    moved: {},
    dropped: {},
    playlistRows: 0,
    genreOverrideMoved: false,
    acquisitionMoved: false,
  };
  if (carry.fromId === carry.toId) return result;

  for (const entry of SONG_CARRY_TABLES) {
    // A minimal test harness may not have every table; a missing one must not
    // take down a migration that would otherwise succeed.
    let r: { moved: number; dropped: number };
    try {
      r = moveRows(db, entry, carry.fromId, carry.toId);
    } catch {
      continue;
    }
    if (r.moved > 0) result.moved[entry.table] = r.moved;
    if (r.dropped > 0) result.dropped[entry.table] = r.dropped;
    if (entry.table === 'playlist_songs') result.playlistRows = r.moved;
  }

  // Not in the registry: its column is `key`, not `song_id`, and it is scoped
  // by `scope = 'song'`, so it needs its own statement and the coverage gate
  // cannot see it by column name. Named here so it is not forgotten.
  result.genreOverrideMoved = moveSongGenreOverride(db, carry.fromId, carry.toId);
  if (result.genreOverrideMoved) result.moved['library_genre_overrides'] = 1;

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
