import type { AcquisitionMethod } from '@nicotind/core';

/** Display metadata for an acquisition method badge (label + emoji glyph). */
export interface MethodBadge {
  label: string;
  glyph: string;
}

const BADGES: Record<AcquisitionMethod, MethodBadge> = {
  // Soulseek is a peer-to-peer network, not a link source — a globe/network
  // glyph reads truer than a chain link (which the URL-based backends avoid).
  slskd: { label: 'Soulseek', glyph: '🌐' },
  ytdlp: { label: 'YouTube', glyph: '▶' },
  spotdl: { label: 'Spotify', glyph: '♫' },
  archive: { label: 'archive.org', glyph: '🏛' },
  unknown: { label: 'Unknown source', glyph: '?' },
};

/** Resolve the badge for a method, defaulting to the unknown badge. */
export function methodBadge(method: AcquisitionMethod | null | undefined): MethodBadge {
  return (method && BADGES[method]) || BADGES.unknown;
}
