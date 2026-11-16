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
  /**
   * Position of the stored words among the source candidates, when "Try another
   * source" wrote the row (#1674). Null otherwise, and once a user edits them.
   */
  walk?: { index: number; total: number } | null;
}

/**
 * Why a stored row's words were chosen, recorded when they were written (#1676)
 * so a song whose lyrics change under a listener is diagnosable rather than
 * anecdotal. **Survives a user edit**: `source`/`sourceTrackId` on the DTO become
 * `'user'`/null when someone edits the text, but this still names the record the
 * words started from — the one a corrected version would be shared back to.
 */
export interface LyricsChoice {
  /** Where the chosen candidate came from: a plugin id, or `'file-tag'`. */
  source: string;
  /** The source's own id for the record, when it gave one. */
  sourceTrackId: string | null;
  /** The chosen candidate carried LRC timings. */
  timed: boolean;
  /** The source's recording length, and the local file's, at the moment of choice. */
  matchedDurationSec: number | null;
  localDurationSec: number | null;
  /** `matchedDurationSec − localDurationSec`; null when either was unknown (unverified). */
  durationDeltaSec: number | null;
  /** The source's own account of how it matched (LRCLIB: `exact` | `search` | `search-unranked`). */
  matchedBy: string | null;
  /** Sources whose untimed answer was passed over because the row was stored timed (#1672). */
  skippedUntimed: string[];
  /**
   * The timed row this replaced was judged another take's words (#1205) — the
   * one case where an untimed candidate may replace timed lyrics.
   */
  replacedOtherTake: boolean;
  /** A forced re-fetch, as opposed to a first fetch. */
  forced: boolean;
  at: number;
  /**
   * Set when the row was written by "Try another source" (#1674); absent on
   * rows from a plain fetch. `index` is 1-based over the de-duplicated list of
   * candidates the walk could apply, `total` its length, and `duplicates` the
   * copies of the same text folded into this one.
   */
  candidateKey?: string;
  index?: number;
  total?: number;
  duplicates?: number;
  via?: 'next';
  /** Better-ranked candidates the walk had already passed, at most 5. */
  passedOver?: LyricsPassedOver[];
}

export interface LyricsPassedOver {
  source: string;
  candidateKey: string;
  timed: boolean;
  durationDeltaSec: number | null;
}

/** What "Try another source" applied: the source line's "n of m" (#1674). */
export interface LyricsApplied {
  source: string;
  sourceTrackId: string | null;
  candidateKey: string;
  /** 1-based position in the list of distinct lyrics the walk may apply. */
  index: number;
  total: number;
  timed: boolean;
}

/**
 * `POST /songs/:id/lyrics/next`. `applied` is the next candidate now stored;
 * `only-one` and `no-match` leave the row unchanged (`lyrics` is the stored row,
 * or null when there is none).
 */
export interface LyricsNextDto {
  outcome: 'applied' | 'only-one' | 'no-match';
  lyrics: LyricsDto | null;
  applied: LyricsApplied | null;
}

/** A user a lyrics row's human correction is attributed to. */
export interface LyricsActor {
  userId: string;
  /** Resolved at read time; null once the account is gone. */
  username: string | null;
}

/** Where a stored row came from, and who corrected it and when. */
export interface LyricsProvenance {
  source: string | null;
  sourceTrackId: string | null;
  /** Null for rows written before #1676, or typed in from nothing. */
  choice: LyricsChoice | null;
  customized: boolean;
  customizedBy: LyricsActor | null;
  customizedAt: number | null;
  /** Last write of the sync offset; cleared with the offset when the text is replaced. */
  offsetBy: LyricsActor | null;
  offsetAt: number | null;
}

/**
 * A song's lyrics as a self-contained record a future share-back could send to
 * its source (#1676 — the upload itself is deliberately not built). Carries the
 * track fields a lyrics database keys on, and **the stored sync offset baked
 * into the LRC's timestamps** (`bakeLyricsOffset`): the timings are the ones a
 * listener actually heard and corrected, and a source has no field for a
 * separate offset.
 */
export interface LyricsExportDto {
  songId: string;
  title: string;
  artist: string;
  album: string | null;
  durationSec: number | null;
  plain: string | null;
  /** The stored LRC with `offsetAppliedMs` folded into every timestamp. */
  synced: string | null;
  /** The stored offset that was baked into `synced` (0 when none was). */
  offsetAppliedMs: number;
  /** A human edited the text or the timing — what is worth sharing back. */
  corrected: boolean;
  provenance: LyricsProvenance;
}
