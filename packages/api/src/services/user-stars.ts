import type { Database } from 'bun:sqlite';

/**
 * Per-user album and artist stars (docs/opensubsonic.md). Song stars are likes
 * and live in the Liked Songs playlist; this table holds only what the like
 * model has no place for, which today only Subsonic clients set.
 */
export type StarredItemType = 'album' | 'artist';

export function starItem(
  db: Database,
  userId: string,
  type: StarredItemType,
  id: string,
  now = Date.now(),
): void {
  db.run(
    `INSERT INTO user_starred_items (user_id, item_type, item_id, starred_at)
     VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    [userId, type, id, now],
  );
}

export function unstarItem(db: Database, userId: string, type: StarredItemType, id: string): void {
  db.run('DELETE FROM user_starred_items WHERE user_id = ? AND item_type = ? AND item_id = ?', [
    userId,
    type,
    id,
  ]);
}

/** Starred ids of one type → when (epoch ms), newest first in iteration order. */
export function starredItems(
  db: Database,
  userId: string,
  type: StarredItemType,
): Map<string, number> {
  const rows = db
    .query<{ item_id: string; starred_at: number }, [string, string]>(
      `SELECT item_id, starred_at FROM user_starred_items
       WHERE user_id = ? AND item_type = ? ORDER BY starred_at DESC`,
    )
    .all(userId, type);
  return new Map(rows.map((r) => [r.item_id, r.starred_at]));
}
