import type { TrackStatus } from '@nicotind/core';

export interface CurrentAndNextTracks {
  /** Title of the track actively downloading, if any. */
  current?: string;
  /** Up to 2 upcoming ('pending') track titles, following `current`. */
  next: string[];
}

/**
 * Compute "what's downloading now" + "what's next" from a unified
 * `DownloadItem.tracks` list, uniform across every acquisition backend.
 *
 * `current` is the LAST entry with status `'downloading'` (a job can retry a
 * track, appending a fresh 'downloading' row after an earlier failed one — the
 * most recent one is the true current). If none is downloading, `current` is
 * left undefined rather than falling back to some other status, so the UI
 * never shows a stale/finished title as "Now".
 *
 * `next` is up to 2 `'pending'` titles, in array order, scanning forward from
 * just after `current`'s position (or from the start when there's no current).
 */
export function currentAndNextTracks(
  tracks: { title: string; status: TrackStatus }[] | undefined,
): CurrentAndNextTracks {
  if (!tracks || tracks.length === 0) return { next: [] };

  let currentIndex = -1;
  for (let i = tracks.length - 1; i >= 0; i--) {
    if (tracks[i].status === 'downloading') {
      currentIndex = i;
      break;
    }
  }

  const current = currentIndex >= 0 ? tracks[currentIndex].title : undefined;
  const startIndex = currentIndex >= 0 ? currentIndex + 1 : 0;

  const next: string[] = [];
  for (let i = startIndex; i < tracks.length && next.length < 2; i++) {
    if (tracks[i].status === 'pending') next.push(tracks[i].title);
  }

  return { current, next };
}

/** Per-status tally behind the card's track disclosure. */
export interface TrackBreakdown {
  total: number;
  done: number;
  /** The source tried and could not deliver these. */
  failed: number;
  /** Deliberately not fetched — already held, or filtered out. */
  skipped: number;
  /** `pending` + `downloading` folded together: not yet resolved either way. */
  inFlight: number;
}

/**
 * Tally a job's tracks by status, or null when there is nothing to tally.
 *
 * `failed` and `skipped` stay separate because they answer different questions
 * — "the source couldn't deliver it" vs "we chose not to fetch it" — and a card
 * that merges them re-hides the distinction the drilldown exists to show (#746).
 */
export function trackBreakdown(
  tracks: { title: string; status: TrackStatus }[] | undefined,
): TrackBreakdown | null {
  if (!tracks || tracks.length === 0) return null;
  const b: TrackBreakdown = { total: tracks.length, done: 0, failed: 0, skipped: 0, inFlight: 0 };
  for (const t of tracks) {
    if (t.status === 'done') b.done++;
    else if (t.status === 'failed') b.failed++;
    else if (t.status === 'skipped') b.skipped++;
    else b.inFlight++;
  }
  return b;
}
