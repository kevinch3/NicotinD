import type { ArchiveCandidate } from './archive.js';
import type { SpotifyCandidate } from './spotify.js';

/**
 * Source-agnostic acquisition model. **The single shape every provider maps to.**
 *
 * Search and hunt across all sources (Soulseek, archive.org, Spotify, future)
 * converge on `AcquisitionCandidate`, so the UI renders ONE blended, ranked list
 * with a neutral per-row source chip and a single "Get" action — never a
 * "primary network" with secondary "Also on…" lanes. Orchestrators and the web
 * depend on this contract, not on any concrete client. See
 * docs/source-agnostic-acquisition.md.
 */

/** Stable source key. Open string so a new plugin needs no enum edit. */
export type AcquisitionSourceId = 'soulseek' | 'archive' | 'spotify' | (string & {});

/** What a candidate represents — drives the subtitle and grouping in the UI. */
export type AcquisitionKind = 'album' | 'single' | 'track' | 'folder';

/**
 * How to acquire a candidate. The single Get action dispatches on `via`:
 * - `url`   → `POST /api/acquire` (archive.org item, Spotify→spotDL, yt-dlp, …)
 * - `enqueue` → the source's download capability (slskd: peer + folder files)
 */
export type AcquireIntent =
  | { via: 'url'; url: string }
  | { via: 'enqueue'; sourceRef: string; files: { filename: string; size: number }[] };

export interface AcquisitionCandidate {
  source: AcquisitionSourceId;
  /** Human label for the chip: "Soulseek" | "Internet Archive" | "Spotify". */
  sourceLabel: string;
  kind: AcquisitionKind;
  title: string;
  artist?: string;
  year?: number;
  trackCount?: number;
  coverUrl?: string;
  /** "FLAC" | "MP3 320kbps" | … when known (mainly slskd folders). */
  format?: string;
  sizeMb?: number;
  /** Peer health (slskd) used to rank deliverability. */
  availability?: { freeSlots?: number; queueLength?: number };
  /** 0–100 confidence/match used as the primary cross-source sort key. */
  score?: number;
  acquire: AcquireIntent;
}

export const SOURCE_LABELS: Record<string, string> = {
  soulseek: 'Soulseek',
  archive: 'Internet Archive',
  spotify: 'Spotify',
};

/** Neutral display label for a source id (falls back to the id itself). */
export function sourceLabel(source: AcquisitionSourceId): string {
  return SOURCE_LABELS[source] ?? source;
}

const yearToNum = (y: string | null | undefined): number | undefined => {
  if (!y) return undefined;
  const m = /^(\d{4})/.exec(y);
  return m ? Number(m[1]) : undefined;
};

/** Map an archive.org item to the unified candidate (acquire via its detailsUrl). */
export function archiveToCandidate(c: ArchiveCandidate): AcquisitionCandidate {
  return {
    source: 'archive',
    sourceLabel: SOURCE_LABELS.archive,
    kind: c.kind === 'single' ? 'single' : 'album',
    title: c.title,
    artist: c.creator || undefined,
    year: yearToNum(c.year),
    trackCount: c.trackCount ?? undefined,
    acquire: { via: 'url', url: c.detailsUrl },
  };
}

/** Map a Spotify album to the unified candidate (acquire the album URL via spotDL). */
export function spotifyToCandidate(c: SpotifyCandidate): AcquisitionCandidate {
  return {
    source: 'spotify',
    sourceLabel: SOURCE_LABELS.spotify,
    kind: c.kind === 'single' ? 'single' : 'album',
    title: c.title,
    artist: c.artist || undefined,
    year: yearToNum(c.year),
    trackCount: c.trackCount ?? undefined,
    coverUrl: c.coverUrl,
    acquire: { via: 'url', url: c.url },
  };
}

const FORMAT_RANK = (format: string | undefined): number => {
  if (!format) return 1;
  const f = format.toUpperCase();
  if (f.includes('FLAC') || f.includes('WAV') || f.includes('AIFF')) return 2; // lossless
  return 1;
};

const availabilityRank = (c: AcquisitionCandidate): number => {
  // A URL source is always deliverable; a slskd folder depends on a free peer slot.
  if (c.acquire.via === 'url') return 1;
  return (c.availability?.freeSlots ?? 0) > 0 ? 1 : 0;
};

/**
 * Cross-source ranking (pure, stable). Best-first by: confidence/score, then
 * lossless format, then peer availability, then track count, then a tie-break on
 * source so ordering is deterministic. Mirrors the slskd folder comparator's
 * spirit (FLAC + free slot win) while staying source-neutral.
 */
export function rankCandidates(candidates: AcquisitionCandidate[]): AcquisitionCandidate[] {
  return [...candidates].sort((a, b) => {
    const score = (b.score ?? 0) - (a.score ?? 0);
    if (score !== 0) return score;
    const fmt = FORMAT_RANK(b.format) - FORMAT_RANK(a.format);
    if (fmt !== 0) return fmt;
    const avail = availabilityRank(b) - availabilityRank(a);
    if (avail !== 0) return avail;
    const tracks = (b.trackCount ?? 0) - (a.trackCount ?? 0);
    if (tracks !== 0) return tracks;
    return a.source.localeCompare(b.source);
  });
}

const dedupeKey = (c: AcquisitionCandidate): string => {
  if (c.acquire.via === 'url') return `url:${c.acquire.url}`;
  return `enqueue:${c.acquire.sourceRef}:${c.acquire.files[0]?.filename ?? c.title}`;
};

/**
 * Merge candidate lists from multiple sources into one ranked list. De-dupes on
 * the acquire target (same URL / same peer-folder), keeping the higher-scoring
 * instance, then ranks. why: the same release can surface from several sources;
 * the blended list should show it once, best copy first.
 */
export function mergeCandidates(...lists: AcquisitionCandidate[][]): AcquisitionCandidate[] {
  const byKey = new Map<string, AcquisitionCandidate>();
  for (const c of lists.flat()) {
    const key = dedupeKey(c);
    const prev = byKey.get(key);
    if (!prev || (c.score ?? 0) > (prev.score ?? 0)) byKey.set(key, c);
  }
  return rankCandidates([...byKey.values()]);
}
