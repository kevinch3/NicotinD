import type { AddonAlbumCandidate } from '@nicotind/core';
import { normalizeTitle, titlesOverlap } from '@nicotind/core';

/**
 * Picking a different peer for the tracks a download is stuck on (#1065).
 *
 * Everything here is pure: the route does the I/O (re-hunt, create job,
 * supersede rows) and this module answers the two questions that decide the
 * outcome — *which* of the wanted tracks a candidate actually offers, and
 * which candidate to put in front of the user first.
 *
 * → docs/download-pipeline.md "Re-sourcing from another peer"
 */

/** One alternate peer, as the picker renders it. */
export interface AlternateSource {
  candidateRef: string;
  username: string;
  directory: string;
  /** The wanted titles this peer offers, verbatim as they were asked for. */
  coveredTitles: string[];
  format: string;
  estimatedSizeMb: number;
  freeUploadSlots: number;
  queueLength: number;
  uploadSpeed: number;
}

/**
 * Which of `wanted` this candidate's folder actually contains.
 *
 * Matched against filenames with the shared `normalizeTitle` / `titlesOverlap`
 * — the same pair the hunt engine and the organizer use, so a peer judged to
 * have "Bésame mucho" here is judged to have it everywhere else too. A local
 * matcher would be a second opinion on the one question the whole feature
 * turns on.
 *
 * Each wanted title is counted at most once even when several files match it;
 * a folder holding three encodes of one track still covers one track.
 */
export function coveredTitles(wanted: string[], candidate: AddonAlbumCandidate): string[] {
  const names = candidate.files.map((f) => normalizeTitle(basename(f.filename)));
  return wanted.filter((title) => {
    const needle = normalizeTitle(title);
    return needle.length > 0 && names.some((name) => titlesOverlap(needle, name));
  });
}

/** Peer paths use backslashes; the title lives in the last segment either way. */
function basename(filename: string): string {
  const cut = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'));
  const base = cut >= 0 ? filename.slice(cut + 1) : filename;
  return base.replace(/\.[a-z0-9]{2,5}$/i, '');
}

/**
 * The alternates worth offering, best first.
 *
 * Two rules, in order:
 *
 * 1. **Not a peer we are already using.** A "different peer" that is the same
 *    peer is the stuck download again. `exclude` is the job's live peers.
 * 2. **Coverage, then availability.** Coverage first because a peer that has
 *    11 of the 14 missing tracks beats a faster one with 3. Availability
 *    second because it is the thing that was actually wrong: the card in #1065
 *    sat at 0 of 14 for ten hours behind a peer with no free slots, and every
 *    other ranking signal said that peer was fine.
 *
 * Deliberately NOT ranked by format or bitrate. Which encode you want is a
 * taste call that depends on what the peer has and what the library already
 * holds — so the format is carried on every row and the choice is left to the
 * person looking at the picker, which is what the picker is for.
 *
 * Zero-coverage candidates are dropped: offering a peer that has none of the
 * missing tracks is offering a button that cannot work.
 */
export function rankAlternates(
  wanted: string[],
  candidates: AddonAlbumCandidate[],
  exclude: Iterable<string> = [],
): AlternateSource[] {
  const excluded = new Set(exclude);
  return candidates
    .filter((c) => !excluded.has(c.username))
    .map((c) => ({
      candidateRef: c.candidateRef,
      username: c.username,
      directory: c.directory,
      coveredTitles: coveredTitles(wanted, c),
      format: c.format,
      estimatedSizeMb: c.estimatedSizeMb,
      freeUploadSlots: c.freeUploadSlots ?? 0,
      queueLength: c.queueLength ?? 0,
      uploadSpeed: c.uploadSpeed ?? 0,
    }))
    .filter((a) => a.coveredTitles.length > 0)
    .sort(
      (a, b) =>
        b.coveredTitles.length - a.coveredTitles.length ||
        b.freeUploadSlots - a.freeUploadSlots ||
        a.queueLength - b.queueLength ||
        b.uploadSpeed - a.uploadSpeed ||
        a.username.localeCompare(b.username),
    );
}
