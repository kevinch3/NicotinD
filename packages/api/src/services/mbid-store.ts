/**
 * Persisted MusicBrainz ids (issue #187 A1 prerequisite).
 *
 * docs/library-scanner.md warns against fuzzy-by-name MusicBrainz lookups, and
 * #187 required MBIDs be persisted first so genre lookups query BY ID. Stored in
 * a side table rather than as `library_albums.mbid` / `library_artists.mbid`
 * columns because those rows are pruned by `synced_at` — an album that briefly
 * disappears would lose a hard-won id and force a re-resolve.
 */

import type { Database } from 'bun:sqlite';

export type MbidScope = 'artist' | 'album';
export type MbidSource = 'tag' | 'lidarr' | 'mb-search' | 'user';

export interface MbidRow {
  scope: MbidScope;
  key: string;
  mbid: string;
  source: MbidSource;
  confidence: number;
  checkedAt: number;
}

/** A tag-read id is exact; anything resolved by matching is not. */
const SOURCE_RANK: Record<MbidSource, number> = {
  user: 4,
  tag: 3,
  lidarr: 2,
  'mb-search': 1,
};

/**
 * Re-resolution cutoff (issue #1008): the first UTC midnight after #611
 * (commit e9aa00e9, 2026-08-21) stopped `pickMbidHit` stamping 0.8 on the
 * first of N same-name hits. → docs/library-scanner.md
 */
export const MBID_AMBIGUITY_FIX_AT = Date.UTC(2026, 7, 22);

/**
 * May an automatic id be resolved again? Only a row the ambiguity fix could
 * have decided differently: `user` and `tag` outrank what a re-resolution
 * could write, so they are never re-queried.
 */
export function isMbidReResolvable(row: MbidRow | null, cutoff = MBID_AMBIGUITY_FIX_AT): boolean {
  if (!row) return false;
  if ((SOURCE_RANK[row.source] ?? 0) > SOURCE_RANK.lidarr) return false;
  return row.checkedAt < cutoff;
}

/**
 * Store an id, keeping the better-sourced one on conflict so a later fuzzy
 * `mb-search` can never downgrade an id read straight from a file's tags.
 */
export function upsertMbid(db: Database, row: Omit<MbidRow, 'checkedAt'>): boolean {
  const existing = db
    .query<{ source: string }, [string, string]>(
      `SELECT source FROM library_mbids WHERE scope = ? AND key = ?`,
    )
    .get(row.scope, row.key);
  if (existing && SOURCE_RANK[existing.source as MbidSource] > SOURCE_RANK[row.source]) {
    return false;
  }
  db.run(
    `INSERT INTO library_mbids (scope, key, mbid, source, confidence, checked_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope, key) DO UPDATE SET
       mbid = excluded.mbid,
       source = excluded.source,
       confidence = excluded.confidence,
       checked_at = excluded.checked_at`,
    [row.scope, row.key, row.mbid, row.source, row.confidence, Date.now()],
  );
  return true;
}

export function getMbid(db: Database, scope: MbidScope, key: string): MbidRow | null {
  let r;
  try {
    r = db
      .query<
        {
          scope: string;
          key: string;
          mbid: string;
          source: string;
          confidence: number;
          checked_at: number;
        },
        [string, string]
      >(`SELECT * FROM library_mbids WHERE scope = ? AND key = ?`)
      .get(scope, key);
  } catch {
    return null;
  }
  if (!r) return null;
  return {
    scope: r.scope as MbidScope,
    key: r.key,
    mbid: r.mbid,
    source: r.source as MbidSource,
    confidence: r.confidence,
    checkedAt: r.checked_at,
  };
}

/**
 * Album titles the library holds for one artist — the corroboration evidence
 * for an ambiguous MBID (issue #610). Lives here rather than in the pure
 * `mbid-corroboration` module so that module stays db-free and replayable.
 */
export function libraryAlbumTitles(db: Database, artistId: string): string[] {
  return db
    .query<{ name: string }, [string]>(`SELECT name FROM library_albums WHERE artist_id = ?`)
    .all(artistId)
    .map((r) => r.name);
}

/** Drop a cached id, reopening the entity to automatic resolution (issue #610). */
export function deleteMbid(db: Database, scope: MbidScope, key: string): void {
  db.run(`DELETE FROM library_mbids WHERE scope = ? AND key = ?`, [scope, key]);
}
