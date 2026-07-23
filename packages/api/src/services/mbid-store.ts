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
