/**
 * Why the tracks a download *didn't* get are missing
 * (docs/download-pipeline.md "Failure breakdown").
 *
 * A partial playlist closes carrying one prose summary from the addon: a
 * header sentence plus one `<url> - <Error>: <detail>` line per track it could
 * not fetch. The card used to render that blob truncated to a single line, so
 * one arbitrary reason stood in for all of them — a user looking at
 * "5 of 89 · 84 unavailable" could not tell a transient throttle (retry helps)
 * from a track the source genuinely lacks (retry is futile).
 *
 * This module is the pure half of fixing that: parse the summary the addon
 * already sends, then classify each reason so the card can group them. Lives
 * in the SDK (not just core) because an addon's own bounded-retry controller
 * needs the identical verdict — re-invoking a download for a `transient`
 * failure and not for `unknown` only works if the addon and the Downloads
 * card agree on which is which (issue #651 item B: this used to be
 * core-only, and a controller built against a second copy would drift the
 * moment either side added a reason).
 */

/** One track the job failed to fetch, as reported by the addon. */
export interface TrackFailure {
  url: string;
  /** The addon's verbatim reason, e.g. `LookupError: No results found for song: X`. */
  reason: string;
}

// Anchored on a real URL rather than "first token before a hyphen": the header
// sentence and any free prose the addon adds must never parse as a track.
const TRACK_FAILURE_RE = /^(https?:\/\/\S+)\s+-\s+(.+)$/;

/**
 * Pull the per-track failures out of an addon's closing summary.
 *
 * Returns `[]` for a whole-job crash (a single sentence, no per-track detail),
 * which keeps the card on its existing single-line rendering rather than
 * showing an empty breakdown.
 */
export function parseJobFailureSummary(summary: string | null | undefined): TrackFailure[] {
  if (!summary) return [];
  const failures: TrackFailure[] = [];
  for (const line of summary.split('\n')) {
    const match = TRACK_FAILURE_RE.exec(line.trim());
    if (match) failures.push({ url: match[1]!, reason: match[2]!.trim() });
  }
  return failures;
}

/**
 * How a failure should be acted on.
 *
 * - `transient` — the source refused *this time*; retrying is likely to work.
 * - `unknown`   — unrecognized, or genuinely ambiguous, and reported as its own
 *                 bucket rather than guessed.
 *
 * There is deliberately no `permanent`: no reason measured on prod can prove a
 * track is absent. The largest bucket (`no results`) is ambiguous by
 * construction — under throttling YouTube Music search returns nothing, so the
 * line a missing track produces is the line a rate-limited one produces. Adding
 * a tier nothing can currently return would be a declared-but-never-written
 * value, which is the defect shape `MbidSource`'s `'user'` tier already cost us
 * once. Widen this union when a reason is *measured* that warrants it.
 */
export type FailureClass = 'transient' | 'unknown';

/**
 * Classify one addon-reported reason so the card can group 84 failures into
 * something a user can act on.
 *
 * The four reasons measured on prod over 12h (issue #601), by frequency:
 *
 * | Reason                                      | Count |
 * | ------------------------------------------- | ----- |
 * | `no usable results` (YT Music search)       |   793 |
 * | `AudioProviderError: YT-DLP download error` |   485 |
 * | `JSONDecodeError: Expecting value…`         |   173 |
 * | `LookupError: No results found for song: X` |   170 |
 *
 * Decided: a throttled/refused fetch is `transient`; a "no results" miss is
 * `unknown`, never guessed — under throttling YouTube Music returns *nothing*,
 * so that line cannot distinguish "the source lacks it" from "the source said
 * no this time". The adaptive fix for the throttling itself is tracked
 * separately (issue #651); this function only has to report honestly.
 *
 * Only reasons actually observed in that table are recognized; anything else is
 * `unknown` rather than assumed.
 */
const TRANSIENT_REASONS = [
  // `ytmusicapi` parses the response body before checking its status code, so a
  // throttled non-JSON reply surfaces as a bare decode error rather than an
  // HTTP one (issue #601).
  /^JSONDecodeError\b/,
  // yt-dlp's media fetch refused — the shape both #588's 403s and ordinary
  // throttling take.
  /^AudioProviderError\b/,
];

export function classifyTrackFailure(reason: string): FailureClass {
  const trimmed = reason.trim();
  if (!trimmed) return 'unknown';
  return TRANSIENT_REASONS.some((re) => re.test(trimmed)) ? 'transient' : 'unknown';
}

/** One class of failure within a job, with a representative reason. */
export interface FailureGroup {
  class: FailureClass;
  count: number;
  /** The commonest verbatim reason in this group, for the detail tooltip. */
  example: string;
}

/**
 * Roll per-track failures up into what a card can actually show.
 *
 * The card has room for a count per class, not 84 lines — so the point is to
 * turn "one arbitrary reason, truncated" into "how many, of which kind".
 * Ordered commonest-first so the dominant cause leads.
 */
export function summarizeFailures(failures: TrackFailure[]): FailureGroup[] {
  const byClass = new Map<FailureClass, Map<string, number>>();
  for (const failure of failures) {
    const klass = classifyTrackFailure(failure.reason);
    const reasons = byClass.get(klass) ?? new Map<string, number>();
    reasons.set(failure.reason, (reasons.get(failure.reason) ?? 0) + 1);
    byClass.set(klass, reasons);
  }

  return [...byClass.entries()]
    .map(([klass, reasons]) => {
      let count = 0;
      let example = '';
      let best = 0;
      for (const [reason, n] of reasons) {
        count += n;
        // Strictly greater, so an earlier reason wins a tie and the output
        // stays stable rather than depending on which arrived last.
        if (n > best) {
          best = n;
          example = reason;
        }
      }
      return { class: klass, count, example };
    })
    .sort((a, b) => b.count - a.count || a.class.localeCompare(b.class));
}
