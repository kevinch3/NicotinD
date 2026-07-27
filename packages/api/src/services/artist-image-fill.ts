import type { Database } from 'bun:sqlite';
import type { Lidarr } from '@nicotind/lidarr-client';
import { indexLidarrArtists, resolveArtistImageUrl } from './artist-image.js';
import { buildArtistImageProviders } from './artist-image-providers.js';
import { isPlaceholderArtist } from './artwork-backfill.js';
import { setArtwork } from './artwork-store.js';
import { clearCoverNegativeCache } from '../routes/streaming.js';

/**
 * Resolve + persist artist portraits — the one implementation shared by the
 * windowed `artist-image` enrichment task, the on-demand per-artist fill route,
 * and `scripts/backfill-artist-images.ts` (issue #250).
 *
 * why: before this, the resolve→persist sequence (build the Lidarr index, build
 * the provider chain, skip placeholder names, `setArtwork`, evict the cover
 * negative-cache) lived only inside the enrichment task's `run`. Adding an
 * on-demand trigger or a bulk script meant copying five coupled steps, and
 * forgetting the `clearCoverNegativeCache` eviction in a copy would produce the
 * worst kind of bug: the portrait is stored, and the UI keeps showing the
 * placeholder until the cache expires.
 *
 * The manual-override short-circuit deliberately stays with the *callers*
 * (their SQL predicate / route guard), matching where the provider chain already
 * puts it — this function only answers "resolve portraits for these artists".
 */

export interface ArtistImageFillDeps {
  lidarr: Lidarr | null | undefined;
  /** Returns a Spotify portrait URL for an artist name, or null. */
  spotifyLookup: ((name: string) => Promise<string | null>) | null;
  coverCacheDir: string;
}

export interface ArtistImageTarget {
  id: string;
  name: string;
}

export interface ArtistImageFillResult {
  applied: number;
  /** `"<artist> → <source>"` per success, for the processing panel's snippets. */
  labels: string[];
  /** Names no configured provider could resolve — the honest miss count. */
  unresolved: string[];
}

/**
 * Fetch the monitored-artist index once, if Lidarr is configured.
 *
 * Wrapped so a Lidarr blip (or, in tests, a partial stub) yields an empty index
 * and the batch still runs via the remaining providers rather than aborting —
 * a portrait backfill must never be the thing that fails a processing window.
 */
async function buildIndex(lidarr: Lidarr | null | undefined) {
  if (!lidarr) return null;
  try {
    return indexLidarrArtists(await lidarr.artist.list());
  } catch {
    return indexLidarrArtists([]);
  }
}

export async function fillArtistImages(
  db: Database,
  deps: ArtistImageFillDeps,
  artists: ArtistImageTarget[],
): Promise<ArtistImageFillResult> {
  const result: ArtistImageFillResult = { applied: 0, labels: [], unresolved: [] };
  if (!artists.length) return result;

  const index = await buildIndex(deps.lidarr);
  // Assembled once and reused across rows — the Lidarr provider closes over the
  // shared index, so per-artist construction would refetch nothing but still
  // rebuild the chain for every row.
  const providers = buildArtistImageProviders({
    db,
    lidarr: deps.lidarr ?? null,
    index,
    spotifyLookup: deps.spotifyLookup,
  });

  for (const artist of artists) {
    // "Various Artists" and friends have no portrait to find; asking wastes a
    // provider round-trip per batch and pollutes the miss list.
    if (isPlaceholderArtist(artist.name)) continue;

    const resolved = await resolveArtistImageUrl(providers, artist);
    if (!resolved) {
      result.unresolved.push(artist.name);
      continue;
    }

    setArtwork(db, artist.id, 'artist', resolved.url, deps.coverCacheDir);
    // The cover route negative-caches an artist 404 (an artist with no portrait
    // is served the placeholder by design), so without this eviction the new
    // portrait stays invisible until that entry expires.
    clearCoverNegativeCache(artist.id);
    result.applied++;
    result.labels.push(`${artist.name} → ${resolved.source}`);
  }

  return result;
}

/** SQL predicate for "needs a portrait": visible, not curator-set, none stored. */
export const NEEDS_PORTRAIT_SQL = `a.hidden = 0 AND a.manual_override = 0
   AND NOT EXISTS (SELECT 1 FROM library_artwork w WHERE w.id = a.id AND w.kind = 'artist')`;

/** Artists still lacking a portrait, most-prolific first (headline names soonest). */
export function selectArtistsNeedingPortrait(db: Database, limit: number): ArtistImageTarget[] {
  return db
    .query<ArtistImageTarget, [number]>(
      `SELECT id, name FROM library_artists a
       WHERE ${NEEDS_PORTRAIT_SQL}
       ORDER BY a.album_count DESC, a.name LIMIT ?`,
    )
    .all(limit);
}

/** How many artists still lack a portrait. */
export function countArtistsNeedingPortrait(db: Database): number {
  return Number(
    (
      db
        .query<{ n: number }, []>(
          `SELECT COUNT(*) AS n FROM library_artists a WHERE ${NEEDS_PORTRAIT_SQL}`,
        )
        .get() ?? { n: 0 }
    ).n,
  );
}
