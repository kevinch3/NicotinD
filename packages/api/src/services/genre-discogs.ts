/**
 * Pure planner for album-scoped Discogs genre enrichment (issue #194).
 *
 * The Discogs `genre` capability is release-scoped — #187 measured artist-level
 * genre coverage at ~3% vs release-group ~67%, so an album-scoped lookup cannot
 * be injected into the existing artist-scoped `genreTask` fan-out. This plans
 * one lookup per album and turns each confident result into an
 * `library_genre_overrides` proposal (the same A1/A3 write path, `source`
 * 'discogs'), reusing the conservative applied/pending discipline.
 *
 * The capability is MBID-only by contract (#193) and already corroborates
 * artist AND album title before returning (selectBestRelease), so its
 * `confidence` IS the gate signal — no second name-based gate here. A
 * high-confidence match auto-applies; a lower one stays `pending` for review,
 * mirroring gateAlbumResolution's 0.8-applied / below-pending bands.
 */

import type { GenreQuery, GenreResult } from '@nicotind/core';

import { albumGroupKey } from './album-grouping.js';
import type { GenreOverrideRow } from './genre-overrides.js';

/** Confidence at or above which a Discogs match auto-applies (else pending). */
export const DISCOGS_APPLY_THRESHOLD = 0.8;

export interface DiscogsGenreAlbum {
  albumId: string;
  albumName: string;
  albumArtist: string;
  /** Release-group (preferred) or release MBID, when known — else null. */
  mbid: string | null;
  songs: { id: string; size: number | null }[];
}

export interface DiscogsGenrePlan {
  /** One override proposal per album Discogs resolved with a non-empty genre set. */
  proposals: GenreOverrideRow[];
  /** Songs of albums that got a definitive answer (resolved or confident miss)
   *  — ledgered so the queue drains. Excludes albums whose lookup *threw* (a
   *  transient outage must retry, never be ledgered out of the queue). */
  processedSongs: { id: string; size: number | null }[];
  /** Albums whose lookup threw — a provider outage signal, not a per-album miss. */
  erroredAlbums: number;
}

/**
 * Resolve genres for each album via the injected release-scoped `resolve`
 * (the Discogs `genre` capability). Pure: all IO is the injected function.
 */
export async function planDiscogsAlbumGenres(
  albums: readonly DiscogsGenreAlbum[],
  resolve: (query: GenreQuery) => Promise<GenreResult | null>,
): Promise<DiscogsGenrePlan> {
  const proposals: GenreOverrideRow[] = [];
  const processedSongs: { id: string; size: number | null }[] = [];
  let erroredAlbums = 0;

  for (const album of albums) {
    const query: GenreQuery = {
      artist: album.albumArtist,
      album: album.albumName,
      ...(album.mbid ? { mbid: { releaseGroup: album.mbid } } : {}),
    };
    let result: GenreResult | null;
    try {
      result = await resolve(query);
    } catch {
      // Transient provider error (429/503/network) — leave the album unledgered
      // so it retries next window, never excluded like a confident miss.
      erroredAlbums++;
      continue;
    }

    // Definitive answer (a hit or a confident miss) — its songs are ledgered.
    processedSongs.push(...album.songs);
    if (!result || result.genres.length === 0) continue;

    proposals.push({
      scope: 'album',
      key: albumGroupKey(album.albumArtist, album.albumName),
      genres: result.genres,
      source: 'discogs',
      mbid: album.mbid,
      confidence: result.confidence,
      status: result.confidence >= DISCOGS_APPLY_THRESHOLD ? 'applied' : 'pending',
      note: `${album.albumArtist} — ${album.albumName} → discogs [${result.genres.join(', ')}]`,
    });
  }

  return { proposals, processedSongs, erroredAlbums };
}
