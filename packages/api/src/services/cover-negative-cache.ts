import type { Database } from 'bun:sqlite';

/**
 * The cover route's negative cache: id → expiry epoch ms. Short-circuits
 * extractCover() disk IO for artless albums. Keyed by album/artist/song id (and
 * the route's `~emb` / remote keys); entries expire after `NO_ART_TTL_MS`.
 *
 * Its own module rather than the route's, so the service-layer cover writers
 * (cover-rev.ts) can evict it without importing a route.
 */
export const noArtCache = new Map<string, number>();
export const NO_ART_TTL_MS = 10 * 60 * 1_000;

/** Evict the negative-art cache for a given id (e.g. after artwork is backfilled). */
export function clearCoverNegativeCache(id?: string): void {
  if (id) noArtCache.delete(id);
  else noArtCache.clear();
}

/**
 * Evict the negative-art cache for an album AND every song id of it. A song id
 * resolves to its album's cover, so after a cover change one that was 404-cached
 * as artless would keep 404ing for up to `NO_ART_TTL_MS` (#1336).
 */
export function clearAlbumCoverNegativeCache(db: Database, albumId: string): void {
  noArtCache.delete(albumId);
  const songs = db
    .query<{ id: string }, [string]>('SELECT id FROM library_songs WHERE album_id = ?')
    .all(albumId);
  for (const { id } of songs) noArtCache.delete(id);
}
