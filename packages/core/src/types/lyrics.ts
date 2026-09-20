/**
 * How far a matched recording's length may sit from the local file's before the
 * match is treated as another take's.
 *
 * Shared deliberately by the two places that must agree: the fetch-time gate
 * that refuses a bad candidate, and the health report that flags rows already
 * stored. Two separate numbers would drift, and the report would then either
 * nag about rows the gate accepts or stay quiet about rows it would reject.
 * "Suspect" therefore has one meaning — *this row would not pass today's gate*.
 */
export const LYRICS_DURATION_TOLERANCE_SEC = 5;

/**
 * How far a stored sync offset may go, in milliseconds.
 *
 * This is a statement, not a safety rail. Real drift between two masters of one
 * performance is seconds; needing half a minute means the stored lyrics are a
 * *different recording*, which is `suspectMatches`' problem and is fixed by
 * re-fetching, not by sliding the wrong words into place.
 */
export const LYRICS_OFFSET_MAX_MS = 30_000;

/** One tap of the nudge control. Fine enough to land a line, coarse enough to get there. */
export const LYRICS_OFFSET_STEP_MS = 250;

/**
 * Stored lyrics for a single library song, as returned by the API. Lyrics are
 * fetched on demand from a lyrics-capable plugin (LRCLIB, …), persisted in the
 * `library_lyrics` side-table, and may be edited by the user.
 */
export interface LyricsDto {
  /** Plain-text lyrics (also written back to the file tag). Null when none. */
  plain: string | null;
  /** Raw LRC (`[mm:ss.xx]` timestamped lines) for karaoke-style highlighting. */
  synced: string | null;
  /** Plugin id that produced the lyrics, or 'user' when manually edited. */
  source: string | null;
  /** True when a user edited the text — protects it from being re-fetched. */
  customized: boolean;
  updatedAt: number;
  /**
   * Length of the recording the source matched. Null means the match was never
   * verified against the local file's duration — a distinct state from
   * "verified and close", and the one that hides wrong lyrics (issue #1212).
   */
  matchedDurationSec?: number | null;
  /** The source's own id for the matched record, for tracing a bad match back. */
  sourceTrackId?: string | null;
  /**
   * Human sync correction, added to every synced timestamp at render time —
   * positive shows the lines later. The fetched text is never rewritten, so
   * this is reversible by setting it back to 0. Cleared whenever the synced
   * text itself changes, because a correction to text that no longer exists is
   * worse than no correction at all.
   */
  offsetMs: number;
}
