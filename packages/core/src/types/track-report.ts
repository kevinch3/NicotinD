/**
 * What a listener can say is wrong with a track (issue #987).
 *
 * The person best placed to notice that a track is mistagged, misnamed or
 * misplaced is the one listening to it, and until now that observation had
 * nowhere to go: curation reached the backlog only through operator-side MCP
 * tools and audit predicates.
 *
 * The reasons are a closed set on purpose. "Report" as a single button produces
 * a queue nobody can triage — "bad" is not an actionable finding — while a
 * named reason routes to a specific fix and makes the backlog sortable.
 */
export const TRACK_REPORT_REASONS = [
  /** Taste, not a defect — see `isTasteOnly`. */
  'not_for_me',
  /** No artwork, no year, no genre, no lyrics. */
  'missing',
  /** Bitrate, clipping, rip artefacts. */
  'quality',
  /** Wrong album or wrong artist. */
  'misplaced',
  /** Wrong metadata values. */
  'mistagged',
  /** Title is a filename, a watermark or a slug. */
  'misnamed',
  'other',
] as const;

export type TrackReportReason = (typeof TRACK_REPORT_REASONS)[number];

export function isTrackReportReason(v: unknown): v is TrackReportReason {
  return typeof v === 'string' && (TRACK_REPORT_REASONS as readonly string[]).includes(v);
}

/**
 * "I don't like it" is the one reason that must **not** reach curation.
 *
 * Nothing is wrong with the track — the listener simply does not want it, which
 * is a fact about them, not about the library. Filing it as a metadata defect
 * would pollute the worklist with items no curator can ever action and would
 * lose the signal where it is actually useful: the recommender already has a
 * home for it (`recommendation_feedback`, kind `exclude`).
 */
export function isTasteOnly(reason: TrackReportReason): boolean {
  return reason === 'not_for_me';
}

/** The flag `reason` text a report becomes. Stable prefix so the backlog sorts by kind. */
export function trackReportReasonText(reason: TrackReportReason, note?: string | null): string {
  const trimmed = (note ?? '').trim();
  return trimmed ? `${reason}: ${trimmed}` : reason;
}
