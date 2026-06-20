import type { SpotifyCandidate } from '../../types/core';

type SpotifyMetaInput = Pick<SpotifyCandidate, 'artist' | 'year' | 'trackCount' | 'kind'>;

/**
 * Build the subtitle parts for a Spotify result: "<artist> · <year> · N tracks ·
 * album/single". Each piece is omitted when absent so a sparse item shows nothing
 * (no literal "Unknown"). Mirrors `archive-display.ts` for a consistent look.
 */
export function spotifyMetaParts(item: SpotifyMetaInput): string[] {
  const parts: string[] = [];
  if (item.artist) parts.push(item.artist);
  if (item.year) parts.push(item.year);
  if (item.trackCount != null && item.trackCount > 0) {
    parts.push(`${item.trackCount} ${item.trackCount === 1 ? 'track' : 'tracks'}`);
  }
  if (item.kind) parts.push(item.kind);
  return parts;
}

/** Joined subtitle string ("" when nothing to show). */
export function spotifySubtitle(item: SpotifyMetaInput): string {
  return spotifyMetaParts(item).join(' · ');
}
