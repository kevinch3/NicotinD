import type { MetadataCandidate, ApplyMetadataRequest } from '../../types/core';

/**
 * Placeholder / "unknown" artist names that poison a "<artist> <album>" query
 * (a rip tagged "<Desconocido>" never matches a real band). Mirrors the API's
 * `isPlaceholderArtist`. Punctuation stripped so "<Desconocido>" → "desconocido".
 */
export function isPlaceholderArtist(artist: string): boolean {
  const a = artist
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (
    a === '' ||
    a === 'desconocido' ||
    a === 'artista desconocido' ||
    a === 'unknown' ||
    a === 'unknown artist' ||
    a === 'various artists' ||
    a === 'various' ||
    a === 'va'
  );
}

/**
 * Default Lidarr query for an album's fix modal: its current "<artist> <album>",
 * but album title alone when the stored artist is a placeholder ("<Desconocido>")
 * that would otherwise poison the search.
 */
export function defaultQuery(artist: string, album: string): string {
  if (isPlaceholderArtist(artist)) return album.trim();
  return `${artist} ${album}`.trim();
}

/** Build an apply request from a confirmed Lidarr candidate. */
export function candidateToRequest(c: MetadataCandidate): ApplyMetadataRequest {
  return {
    artist: c.artist || undefined,
    album: c.title || undefined,
    year: c.year ?? undefined,
    coverUrl: c.coverUrl ?? undefined,
    releaseType: c.releaseType ?? undefined,
    source: 'lidarr',
  };
}

/** Build an apply request from free-text fields, dropping blanks. Null = nothing to apply. */
export function manualToRequest(fields: {
  artist?: string;
  album?: string;
  year?: string | number;
}): ApplyMetadataRequest | null {
  const artist = fields.artist?.trim();
  const album = fields.album?.trim();
  const yearRaw = typeof fields.year === 'string' ? fields.year.trim() : fields.year;
  const year =
    yearRaw === '' || yearRaw == null ? undefined : Number.isFinite(Number(yearRaw)) ? Number(yearRaw) : undefined;
  if (!artist && !album && year == null) return null;
  return {
    artist: artist || undefined,
    album: album || undefined,
    year,
    source: 'manual',
  };
}
