/**
 * Pure resolution + confidence gating for trusted-metadata genres (issue #187
 * task A1). No IO — the MusicBrainz/Lidarr calls live in the caller, so every
 * gating rule below is directly unit-testable and replayable from fixtures.
 *
 * The gate is designed around a real false pair found while measuring #187:
 * an exact-name Lidarr lookup for "Emilia" (Argentine, 26 songs in the library)
 * returned the *Swedish* Emilia, genre `hip hop`. Exact name equality is
 * therefore NOT a sufficient signal to auto-apply — an artist-scope match must
 * additionally be corroborated by at least one album title the library and the
 * candidate share. That single rule is what keeps those 26 songs correct.
 *
 * Measured coverage context (prod, 2026-07-23), so nobody re-litigates this:
 * MusicBrainz artist-level genres cover 2/25 sampled artists (~3% of the gap),
 * release-group level 8/12 — which is why callers resolve album-first and fall
 * back to artist, the inverse of how the issue originally framed it.
 */

import { normalizeArtistForGrouping, normalizeForGrouping } from './album-grouping.js';

export interface MbGenre {
  name: string;
  count: number;
}

export type GateStatus = 'applied' | 'pending';

export interface GateResult {
  confidence: number;
  status: GateStatus;
}

/** At most this many genres from one entity — a noisy entity shouldn't dominate. */
const MAX_GENRES = 4;

/**
 * The genres worth proposing from one MusicBrainz entity: positive-count only
 * (a zero count means nobody actually voted for it), most-voted first, capped.
 * An empty result means "no proposal", never "propose an empty override".
 */
export function pickGenres(genres: readonly MbGenre[]): string[] {
  return [...genres]
    .filter((g) => g.count > 0 && g.name.trim().length > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_GENRES)
    .map((g) => g.name.trim());
}

const titleKey = (s: string): string => normalizeForGrouping(s);

export function gateArtistResolution(input: {
  queryName: string;
  candidateName: string;
  /** Album titles this artist has in the library. */
  libraryAlbumTitles: readonly string[];
  /** Release-group titles MusicBrainz lists for the candidate MBID. */
  releaseGroupTitles: readonly string[];
  /** True when the MBID came from the file's own tags — nothing to mis-match. */
  fromTag?: boolean;
}): GateResult {
  if (input.fromTag) return { confidence: 1, status: 'applied' };

  const exactName =
    normalizeArtistForGrouping(input.queryName) === normalizeArtistForGrouping(input.candidateName);
  if (!exactName) return { confidence: 0.3, status: 'pending' };

  const rgKeys = new Set(input.releaseGroupTitles.map(titleKey));
  const corroborated = input.libraryAlbumTitles.some((t) => rgKeys.has(titleKey(t)));
  return corroborated
    ? { confidence: 0.8, status: 'applied' }
    : { confidence: 0.5, status: 'pending' };
}

export function gateAlbumResolution(input: {
  queryArtist: string;
  queryAlbum: string;
  candidateArtist: string;
  candidateAlbum: string;
  fromTag?: boolean;
}): GateResult {
  if (input.fromTag) return { confidence: 1, status: 'applied' };

  const artistMatch =
    normalizeArtistForGrouping(input.queryArtist) ===
    normalizeArtistForGrouping(input.candidateArtist);
  const albumMatch = titleKey(input.queryAlbum) === titleKey(input.candidateAlbum);

  if (artistMatch && albumMatch) return { confidence: 0.8, status: 'applied' };
  if (artistMatch) return { confidence: 0.5, status: 'pending' };
  return { confidence: 0.3, status: 'pending' };
}
