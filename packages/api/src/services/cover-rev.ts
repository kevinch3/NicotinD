import type { Database } from 'bun:sqlite';
import { libraryEvents } from './library-events.js';
import { clearAlbumCoverNegativeCache, clearCoverNegativeCache } from './cover-negative-cache.js';

export type CoverKind = 'album' | 'artist';

/**
 * Record that an album's or artist's cover bytes changed (#1666): bump the
 * persisted `cover_rev`, evict the cover route's negative cache for the id (and,
 * for an album, every song id that resolves to its cover), and announce the new
 * rev as `artwork.changed`.
 *
 * `cover_rev` is what makes the cover identity travel with the entity: the DTOs
 * carry it beside the id-stable `coverArt`, so a client's cover URL changes when
 * the bytes do. Call it from the service that wrote the art, and only when the
 * stored art actually changed — an unconditional bump would re-key every cover
 * after each enrichment pass. Returns the new rev, or null when no such row
 * exists yet (art written at hunt time, before the album lands, starts at 0).
 *
 * The new rev is one past the higher of the row's rev and
 * `library_cover_rev_floor`, so a deleted and re-landed entity (same
 * name-derived id, back at 0) never re-issues a versioned URL a browser cached
 * for its previous incarnation.
 */
export function bumpCoverRev(db: Database, kind: CoverKind, id: string): number | null {
  const table = kind === 'album' ? 'library_albums' : 'library_artists';
  const rev = db.transaction((): number | null => {
    const row = db
      .query<{ cover_rev: number }, [string]>(`SELECT cover_rev FROM ${table} WHERE id = ?`)
      .get(id);
    if (!row) return null;
    const floor =
      db
        .query<{ rev: number }, [string, string]>(
          'SELECT rev FROM library_cover_rev_floor WHERE kind = ? AND id = ?',
        )
        .get(kind, id)?.rev ?? 0;
    const next = Math.max(row.cover_rev, floor) + 1;
    db.run(`UPDATE ${table} SET cover_rev = ? WHERE id = ?`, [next, id]);
    db.run(
      `INSERT INTO library_cover_rev_floor (kind, id, rev) VALUES (?, ?, ?)
       ON CONFLICT(kind, id) DO UPDATE SET rev = excluded.rev`,
      [kind, id, next],
    );
    return next;
  })();
  if (kind === 'album') clearAlbumCoverNegativeCache(db, id);
  else clearCoverNegativeCache(id);
  if (rev === null) return null;
  libraryEvents.emit({ type: 'artwork.changed', changes: [{ kind, id, rev }] });
  return rev;
}
