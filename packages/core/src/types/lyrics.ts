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
}
