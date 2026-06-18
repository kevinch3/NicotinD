import type { ArchiveCandidate } from '../../types/core';

type ArchiveMetaInput = Pick<ArchiveCandidate, 'creator' | 'year' | 'trackCount' | 'kind'>;

/**
 * Build the subtitle parts for an archive.org result: "<creator> · <year> · N
 * tracks · album/single". Each piece is omitted when absent so a bare item shows
 * nothing (no literal "Unknown"). The track count + kind tell the user whether an
 * item is a single or a multi-track album before they acquire it.
 */
export function archiveMetaParts(item: ArchiveMetaInput): string[] {
  const parts: string[] = [];
  if (item.creator) parts.push(item.creator);
  if (item.year) parts.push(item.year);
  if (item.trackCount != null && item.trackCount > 0) {
    parts.push(`${item.trackCount} ${item.trackCount === 1 ? 'track' : 'tracks'}`);
  }
  if (item.kind) parts.push(item.kind);
  return parts;
}

/** Joined subtitle string ("" when nothing to show). */
export function archiveSubtitle(item: ArchiveMetaInput): string {
  return archiveMetaParts(item).join(' · ');
}
