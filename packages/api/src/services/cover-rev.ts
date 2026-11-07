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
 */
export function bumpCoverRev(db: Database, kind: CoverKind, id: string): number | null {
  const table = kind === 'album' ? 'library_albums' : 'library_artists';
  const row = db
    .query<{ cover_rev: number }, [string]>(
      `UPDATE ${table} SET cover_rev = cover_rev + 1 WHERE id = ? RETURNING cover_rev`,
    )
    .get(id);
  if (kind === 'album') clearAlbumCoverNegativeCache(db, id);
  else clearCoverNegativeCache(id);
  if (!row) return null;
  libraryEvents.emit({ type: 'artwork.changed', changes: [{ kind, id, rev: row.cover_rev }] });
  return row.cover_rev;
}
