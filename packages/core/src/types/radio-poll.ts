import type { LibraryFilter } from './library-filter.js';
import type { Song } from './navidrome.js';

/**
 * Radio evaluation polls (docs/radio-eval-polls.md): an admin freezes N radio
 * scenarios (seed song + K engine-ranked next-up suggestions) behind a public
 * URL, and anonymous raters thumb each suggestion up/down. Snapshots are
 * mandatory — the radio pool is `ORDER BY RANDOM()`, so two generations from
 * the same seed differ; votes are only comparable against a frozen queue.
 *
 * Types are structural copies of the API's radio shapes (`SongFeatures`,
 * `SimilarityExplanation`) rather than imports so `@nicotind/core` stays a leaf
 * package; the API's types are assignable to these.
 */

/** One rater's thumb on one suggestion (binary-scale polls). */
export type RadioPollVerdict = 'up' | 'down';

/** One rater's 1–5 star rating on one suggestion (stars5-scale polls). */
export type PollRating = 1 | 2 | 3 | 4 | 5;

/**
 * How a poll's votes are cast. Stamped server-side into `settings_json` at
 * creation (all new polls are `stars5`); absent = `binary`, i.e. every poll
 * from before the scale existed. Gets the same treatment as
 * `formulaVersion` (issue #583): votes cast under different scales are never
 * silently pooled into one agreement measurement.
 */
export type RadioPollVoteScale = 'binary' | 'stars5';

/**
 * The distilled human consensus for a candidate across all of its votes — a
 * different thing from a single rater's `RadioPollVerdict`. Formerly
 * `GenerationVerdict`, shared with the generation-feedback queue; that feature
 * was removed and poll export is the only remaining user, so it lives here now.
 */
export type PollConsensusVerdict = 'good' | 'bad';

/** The creation request, recorded verbatim in `radio_polls.settings_json`. */
export interface RadioPollSettings {
  /** Scenarios to generate, 1..20. */
  scenarioCount: number;
  /** Next-up suggestions per scenario (K), 1..10. */
  nextUpCount: number;
  /** Seed song ids the admin pinned (consume scenario slots first). */
  pinnedSeedIds?: string[];
  /**
   * Station ("vibe") scenarios — each filter becomes one `kind: 'filter'`
   * scenario, generated after the pinned seeds and before the random auto
   * seeds. Plural because the question these answer is "are my genre stations
   * any good", and one station per poll can't tell you that; the landing page
   * alone offers eight chips. Was a reserved singular `filter` that nothing
   * ever wrote.
   */
  filters?: LibraryFilter[];
  /** Scoring-weight overrides actually used, merged onto the engine defaults. */
  weights?: Record<string, number>;
  /** Vote scale, stamped server-side at creation; absent = 'binary' (legacy). */
  voteScale?: RadioPollVoteScale;
}

/** Structural copy of the API's `AxisContribution`. */
export interface RadioPollAxis {
  axis: string;
  value: number;
  weight: number;
  contribution: number;
}

/** Structural copy of the API's `SimilarityExplanation`. */
export interface RadioPollExplanation {
  score: number;
  axes: RadioPollAxis[];
  skipped: string[];
  floored: string[];
  artistPenaltyApplied: boolean;
  recentPlayPenaltyApplied: number;
}

/**
 * Structural copy of the API's `SongFeatures` minus `embedding` (a
 * Float32Array — JSON.stringify would turn it into an index-keyed blob) and
 * `recentPlayFactor` (listener-relative; polls generate without a listener).
 * The snapshot builder strips both before persisting.
 */
export interface RadioPollSnapshotFeatures {
  bpm?: number;
  key?: string;
  genre?: string;
  genres?: string[];
  originCountries?: string[];
  duration: number;
  year?: number;
  artistId: string;
  energy?: number;
  valence?: number;
  danceability?: number;
  instrumental?: number;
  acousticness?: number;
  /** Station scenarios: the graded membership that replaced the genre axis, so
   *  a replay reproduces the ranking the raters actually saw. */
  stationAffinity?: number;
  /**
   * Descriptor blocks (formula v5, issue #642) — plain arrays, kept in the
   * snapshot on purpose: they are what lets the eval harness re-weight the
   * timbre / groove / spectralBalance axes on frozen votes. A feature missing
   * here is dropped from every snapshot and can never be measured.
   */
  timbre?: number[];
  groove?: number[];
  bands?: number[];
}

/** One frozen next-up suggestion inside a scenario. */
export interface RadioPollCandidateSnapshot {
  /** Full display row, frozen at creation (survives later deletes/rescans). */
  song: Song;
  features: RadioPollSnapshotFeatures;
  score: number;
  /** 1-based engine rank. */
  rank: number;
  /**
   * Frozen presentation order. Currently equal to `rank` (the wizard emulates
   * the real queue), but stored separately so an anti-position-bias shuffle is
   * a generation-time change with no schema impact.
   */
  displayOrder: number;
  explanation: RadioPollExplanation;
}

/** `radio_poll_scenarios.snapshot_json`. */
export interface RadioPollScenarioSnapshot {
  kind: 'seed' | 'filter';
  /** Null for filter (centroid) scenarios. */
  seed: { song: Song; features: RadioPollSnapshotFeatures } | null;
  /** Pool centroid, filter scenarios only. */
  centroid?: RadioPollSnapshotFeatures;
  filter?: LibraryFilter;
  /** The full weight set the ranking actually used. */
  weights: Record<string, number>;
  candidates: RadioPollCandidateSnapshot[];
}

// ---------------------------------------------------------------------------
// Public wire DTOs — deliberately lean: no features, scores or explanations.
// Those are admin/export surfaces; leaking the engine's own ranking to raters
// would also bias the vote.
// ---------------------------------------------------------------------------

export interface PublicPollTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  /** Cover *id* (not URL) — render via `/api/cover/:id?size=…&token=<mediaJwt>`. */
  coverArt: string;
  duration: number;
}

export interface PublicPollScenario {
  id: string;
  position: number;
  /** Null for filter scenarios (rendered with `filterLabel` instead). */
  seed: PublicPollTrack | null;
  filterLabel?: string;
  /** In frozen display order. */
  candidates: PublicPollTrack[];
}

/** Response of `GET /api/radio-polls/public/:token`. */
export interface PublicPollView {
  poll: {
    name: string;
    scenarioCount: number;
    nextUpCount: number;
    /** Drives which rating control the wizard renders (stars vs thumbs). */
    voteScale: RadioPollVoteScale;
  };
  scenarios: PublicPollScenario[];
  /** Short-lived read-only JWT for `/api/stream` + `/api/cover` (`?token=`). */
  mediaJwt: string;
  /** ms epoch — the wizard silently re-fetches before this to refresh the JWT. */
  mediaJwtExpiresAt: number;
}

/** Body of `POST /api/radio-polls/public/:token/votes`. */
export interface PublicPollVoteBody {
  /** Anonymous per-device UUID (8..64 chars) — dedupe key, never an identity. */
  raterKey: string;
  votes: Array<{
    scenarioId: string;
    candidateSongId: string;
    /** Binary polls: required. Rejected on a stars5 poll (client confusion). */
    verdict?: RadioPollVerdict;
    /** Stars5 polls: required. Rejected on a binary poll. */
    rating?: PollRating;
    note?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Admin DTOs
// ---------------------------------------------------------------------------

export interface RadioPollSummary {
  id: string;
  token: string;
  /** Absolute public URL (`<origin>/poll/<token>`). */
  url: string;
  name: string;
  createdAt: number;
  expiresAt: number | null;
  closedAt: number | null;
  scenarioCount: number;
  voteCount: number;
  raterCount: number;
  /** Similarity-formula version that generated the scenarios
   *  (`RADIO_FORMULA_VERSION`); null = created before versioning (formula 1). */
  formulaVersion: string | null;
  voteScale: RadioPollVoteScale;
}

export interface RadioPollCandidateResult extends RadioPollCandidateSnapshot {
  /** Derived-verdict tallies on stars5 polls; the raw thumbs on binary polls. */
  up: number;
  down: number;
  /** Votes that carried a star rating (0 on binary polls). */
  ratingCount: number;
  meanRating: number | null;
  /** Histogram of ratings 1..5 (index 0 = one star). */
  ratingCounts: number[];
}

export interface RadioPollScenarioResult {
  id: string;
  position: number;
  kind: 'seed' | 'filter';
  seed: { song: Song; features: RadioPollSnapshotFeatures } | null;
  filterLabel?: string;
  /** Station scenarios: the scoring seed (there is no seed song) and the filter
   *  that defined the station — both needed by the offline eval harness, which
   *  otherwise has nothing to re-score a station's candidates against. */
  centroid?: RadioPollSnapshotFeatures;
  filter?: LibraryFilter;
  /** The full weight set the ranking used (from the frozen snapshot). */
  weights: Record<string, number>;
  candidates: RadioPollCandidateResult[];
}

/** Response of `GET /api/admin/radio-polls/:id` — the diagnosis surface. */
export interface RadioPollResults {
  poll: RadioPollSummary;
  settings: RadioPollSettings;
  scenarios: RadioPollScenarioResult[];
}
