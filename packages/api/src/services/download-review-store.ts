import type { Database } from 'bun:sqlite';
import { loadQuarantineQueue, type QuarantineAlbum } from './song-steps.js';

export type ReviewState = 'approved' | 'discarded';

export interface ReviewDecision {
  albumId: string;
  state: ReviewState;
  reviewedBy: string | null;
  reviewedAt: string;
}

/** A quarantined song lacking a covering decision row (decision at/after the song's scan time). */
export const PENDING_REVIEW_SQL = `NOT EXISTS (
  SELECT 1 FROM download_reviews r
   WHERE r.album_id = library_songs.album_id
     AND (library_songs.created IS NULL OR r.reviewed_at >= library_songs.created)
)`;

export function recordReviewDecision(
  db: Database,
  albumId: string,
  state: ReviewState,
  reviewedBy: string | null,
  now: Date = new Date(),
): void {
  db.run(
    `INSERT INTO download_reviews (album_id, state, reviewed_by, reviewed_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(album_id) DO UPDATE SET state = excluded.state,
       reviewed_by = excluded.reviewed_by, reviewed_at = excluded.reviewed_at`,
    [albumId, state, reviewedBy, now.toISOString()],
  );
}

export function getReviewDecision(db: Database, albumId: string): ReviewDecision | null {
  const row = db
    .query(
      `SELECT album_id, state, reviewed_by, reviewed_at FROM download_reviews WHERE album_id = ?`,
    )
    .get(albumId) as {
    album_id: string;
    state: ReviewState;
    reviewed_by: string | null;
    reviewed_at: string;
  } | null;
  return row
    ? {
        albumId: row.album_id,
        state: row.state,
        reviewedBy: row.reviewed_by,
        reviewedAt: row.reviewed_at,
      }
    : null;
}

function pendingAlbumIds(db: Database): Set<string> {
  const rows = db
    .query(
      `SELECT DISTINCT album_id FROM library_songs
        WHERE landed_at IS NULL AND hidden = 0 AND ${PENDING_REVIEW_SQL}`,
    )
    .all() as Array<{ album_id: string }>;
  return new Set(rows.map((r) => r.album_id));
}

export interface ReviewQueueAlbum extends QuarantineAlbum {
  year: number | null;
}

export function loadReviewQueue(db: Database): ReviewQueueAlbum[] {
  const pending = pendingAlbumIds(db);
  const years = new Map(
    (
      db.query(`SELECT id, year FROM library_albums`).all() as Array<{
        id: string;
        year: number | null;
      }>
    ).map((r) => [r.id, r.year] as const),
  );
  return loadQuarantineQueue(db)
    .filter((a) => pending.has(a.albumId))
    .map((a) => ({ ...a, year: years.get(a.albumId) ?? null }));
}

export function pendingReviewCount(db: Database): number {
  return pendingAlbumIds(db).size;
}
