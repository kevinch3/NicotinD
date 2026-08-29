import type { Database } from 'bun:sqlite';
import type {
  PollConsensusVerdict,
  LibraryFilter,
  RadioPollCandidateResult,
  RadioPollSettings,
  RadioPollVoteScale,
} from '@nicotind/core';
import { pollResults, pollVoteScale, type RadioPollRow } from './radio-poll-store.js';

/**
 * Offline dataset distilled from one poll — the "digested later" half of
 * docs/radio-eval-polls.md. Self-contained: frozen features + per-axis
 * explanations + human tallies, so weight tuning can replay
 * `scoreSimilarity` with no live library.
 */
export interface RadioPollExportDataset {
  pollId: string;
  name: string;
  createdAt: number;
  engineVersion: string | null;
  /** Similarity-formula version the scenarios were generated under; rows from
   *  before versioning report '1'. Datasets with different values must not be
   *  pooled into one agreement measurement. */
  formulaVersion: string;
  /** Vote scale the poll collected under (issue #800). Same never-pool rule as
   *  `formulaVersion`; older dataset files on disk lack the field = binary. */
  voteScale: RadioPollVoteScale;
  settings: RadioPollSettings;
  raterCount: number;
  voteCount: number;
  scenarios: Array<{
    id: string;
    position: number;
    kind: 'seed' | 'filter';
    seed: { songId: string; title: string; artist: string; features: unknown } | null;
    /** Station scenarios only: the scoring seed, since there is no seed song.
     *  Without it the eval harness had nothing to re-score against and skipped
     *  every filter scenario outright. */
    centroid?: unknown;
    filter?: LibraryFilter;
    weights: Record<string, number>;
    candidates: Array<{
      songId: string;
      title: string;
      artist: string;
      features: unknown;
      score: number;
      rank: number;
      explanation: unknown;
      up: number;
      down: number;
      ratingCount: number;
      meanRating: number | null;
      /** Histogram of ratings 1..5 — keeps variance/bimodality analyzable. */
      ratingCounts: number[];
      consensus: PollConsensusVerdict | null;
    }>;
  }>;
}

/**
 * The human consensus for one candidate: majority up = the suggestion was
 * good, majority down = bad, tie or zero votes = ungraded (excluded from any
 * fixture/ratchet downstream — an ambiguous grade is worse than none).
 */
export function consensusVerdict(up: number, down: number): PollConsensusVerdict | null {
  if (up > down) return 'good';
  if (down > up) return 'bad';
  return null;
}

/**
 * The stars5 counterpart of `consensusVerdict`: distill a candidate's mean
 * rating into the good/bad/ungraded vocabulary for summaries and future
 * fixtures. The pairwise eval deliberately does NOT use this — its pairs come
 * from raw mean inequality — so this rule shapes only human-readable output.
 *
 * Current rule: a dead zone. ≥3.5 is an endorsement, ≤2.5 a rejection, and
 * the middle stays ungraded rather than stamping a 3.2 "good" into a fixture.
 */
export function gradedConsensus(
  meanRating: number | null,
  ratingCount: number,
): PollConsensusVerdict | null {
  if (meanRating === null || ratingCount === 0) return null;
  if (meanRating >= 3.5) return 'good';
  if (meanRating <= 2.5) return 'bad';
  return null;
}

function exportCandidate(
  c: RadioPollCandidateResult,
  scale: RadioPollVoteScale,
): RadioPollExportDataset['scenarios'][number]['candidates'][number] {
  return {
    songId: c.song.id,
    title: c.song.title,
    artist: c.song.artist,
    features: c.features,
    score: c.score,
    rank: c.rank,
    explanation: c.explanation,
    up: c.up,
    down: c.down,
    ratingCount: c.ratingCount,
    meanRating: c.meanRating,
    ratingCounts: c.ratingCounts,
    consensus:
      scale === 'stars5'
        ? gradedConsensus(c.meanRating, c.ratingCount)
        : consensusVerdict(c.up, c.down),
  };
}

export function pollExportDataset(db: Database, poll: RadioPollRow): RadioPollExportDataset {
  const results = pollResults(db, poll);
  const scale = pollVoteScale(results.settings);
  return {
    pollId: poll.id,
    name: poll.name,
    createdAt: poll.created_at,
    engineVersion: poll.engine_version,
    formulaVersion: poll.formula_version ?? '1',
    voteScale: scale,
    settings: results.settings,
    raterCount: results.poll.raterCount,
    voteCount: results.poll.voteCount,
    scenarios: results.scenarios.map((s) => ({
      id: s.id,
      position: s.position,
      kind: s.kind,
      seed: s.seed
        ? {
            songId: s.seed.song.id,
            title: s.seed.song.title,
            artist: s.seed.song.artist,
            features: s.seed.features,
          }
        : null,
      centroid: s.centroid,
      filter: s.filter,
      weights: s.weights,
      candidates: s.candidates.map((c) => exportCandidate(c, scale)),
    })),
  };
}
