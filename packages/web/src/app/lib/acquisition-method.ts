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
  // The admin folder-import flow (docs/import.md) — files the user already had.
  import: { label: 'Imported', glyph: '📁' },
  unknown: { label: 'Unknown source', glyph: '?' },
};

/** Any addon the web has no badge of its own for: an extension piece. */
const ADDON_GLYPH = '🧩';

/**
 * Resolve the badge for a method. A first-party method keeps its own badge;
 * any other source — a third-party addon — is named by `sourceName`, its
 * manifest name (`PluginService.names`). Sources are user-added, so the web
 * cannot know them all and must not call one it does not know "unknown"; only
 * a source with no name at all is (docs/source-agnostic-acquisition.md).
 */
export function methodBadge(
  method: AcquisitionMethod | null | undefined,
  sourceName?: string | null,
): MethodBadge {
  const known = method ? BADGES[method] : undefined;
  if (known && method !== 'unknown') return known;
  if (sourceName) return { label: sourceName, glyph: ADDON_GLYPH };
  return BADGES.unknown;
}
