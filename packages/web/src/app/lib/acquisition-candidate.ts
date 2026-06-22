// Source-agnostic blended results for the search page + album-hunt modal.
//
// Every acquirable result — a Soulseek peer file, an archive.org item, a Spotify
// album — maps to one `BlendedCandidate` so the UI renders ONE ranked list with a
// neutral per-row source chip and a single Get action (no "primary network" +
// secondary "Also on…" lanes). The `acquire` intent is a discriminated union the
// Get handler dispatches on. See docs/source-agnostic-acquisition.md.

import type { ArchiveCandidate, SpotifyCandidate } from '../../types/core';
import { formatBadge, fileExt, type SongResult } from './song-results';
import { archiveSubtitle } from './archive-display';
import { spotifySubtitle } from './spotify-display';

export type CandidateSource = 'soulseek' | 'archive' | 'spotify';

export const SOURCE_LABELS: Record<CandidateSource, string> = {
  soulseek: 'Soulseek',
  archive: 'Internet Archive',
  spotify: 'Spotify',
};

export interface BlendedCandidate {
  /** Stable key for tracking download/acquired state + trackBy. */
  id: string;
  source: CandidateSource;
  sourceLabel: string;
  title: string;
  /** "artist · year · N tracks · format" — already source-formatted, may be ''. */
  subtitle: string;
  /** Short format badge ("FLAC", "320k MP3") when known (Soulseek files). */
  format?: string;
  coverUrl?: string;
  /** Cross-source ranking key (higher = better). */
  score: number;
  acquire:
    | { via: 'enqueue'; username: string; file: { filename: string; size: number } }
    | { via: 'url'; url: string };
}

const LOSSLESS_FORMAT_BONUS = 30;

/** Soulseek song → candidate. Score rewards lossless + an available peer slot. */
export function songResultToCandidate(s: SongResult): BlendedCandidate {
  const ext = fileExt(s.best.filename);
  const lossless = ext === 'flac' || ext === 'wav' || ext === 'aiff' || ext === 'ape' || ext === 'wv';
  const hasSlot = (s.best.freeUploadSlots ?? 0) > 0;
  const score = 50 + (lossless ? LOSSLESS_FORMAT_BONUS : 0) + (hasSlot ? 15 : 0);
  const subtitle = [s.artist, formatBadge(s.best)].filter(Boolean).join(' · ');
  return {
    id: `soulseek:${s.best.username}:${s.best.filename}`,
    source: 'soulseek',
    sourceLabel: SOURCE_LABELS.soulseek,
    title: s.title,
    subtitle,
    format: formatBadge(s.best),
    score,
    acquire: {
      via: 'enqueue',
      username: s.best.username,
      file: { filename: s.best.filename, size: s.best.size },
    },
  };
}

/** archive.org item → candidate. Mid baseline score (album-level metadata hit). */
export function archiveToCandidate(a: ArchiveCandidate): BlendedCandidate {
  return {
    id: `archive:${a.identifier}`,
    source: 'archive',
    sourceLabel: SOURCE_LABELS.archive,
    title: a.title,
    subtitle: archiveSubtitle(a),
    score: 62,
    acquire: { via: 'url', url: a.detailsUrl },
  };
}

/** Spotify album → candidate (acquired via spotDL). */
export function spotifyToCandidate(s: SpotifyCandidate): BlendedCandidate {
  return {
    id: `spotify:${s.id}`,
    source: 'spotify',
    sourceLabel: SOURCE_LABELS.spotify,
    title: s.title,
    subtitle: spotifySubtitle(s),
    coverUrl: s.coverUrl,
    score: 56,
    acquire: { via: 'url', url: s.url },
  };
}

const SOURCE_ORDER: Record<CandidateSource, number> = { soulseek: 0, archive: 1, spotify: 2 };

/**
 * Merge candidate lists into one ranked list (best-first by score, then a stable
 * source/title tiebreak). Pure — unit-tested; drives the blended Results list.
 */
export function mergeAndRank(...lists: BlendedCandidate[][]): BlendedCandidate[] {
  return lists.flat().sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (SOURCE_ORDER[a.source] !== SOURCE_ORDER[b.source]) {
      return SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source];
    }
    return a.title.localeCompare(b.title);
  });
}
