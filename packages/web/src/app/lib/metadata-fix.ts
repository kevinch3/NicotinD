import type { MetadataCandidate, ApplyMetadataRequest } from '../../types/core';

/** Default Lidarr query for an album's fix modal: its current "<artist> <album>". */
export function defaultQuery(artist: string, album: string): string {
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
