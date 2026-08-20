import type { Database } from 'bun:sqlite';
import type {
  GenerationVerdict,
  RadioPollCandidateResult,
  RadioPollSettings,
} from '@nicotind/core';
import { pollResults, type RadioPollRow } from './radio-poll-store.js';

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
  settings: RadioPollSettings;
  raterCount: number;
  voteCount: number;
  scenarios: Array<{
    id: string;
    position: number;
    kind: 'seed' | 'filter';
    seed: { songId: string; title: string; artist: string; features: unknown } | null;
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
      consensus: GenerationVerdict | null;
    }>;
  }>;
}

/**
 * The human consensus for one candidate: majority up = the suggestion was
 * good, majority down = bad, tie or zero votes = ungraded (excluded from any
 * fixture/ratchet downstream — an ambiguous grade is worse than none).
 */
export function consensusVerdict(up: number, down: number): GenerationVerdict | null {
  if (up > down) return 'good';
  if (down > up) return 'bad';
  return null;
}

function exportCandidate(
  c: RadioPollCandidateResult,
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
    consensus: consensusVerdict(c.up, c.down),
  };
}

export function pollExportDataset(db: Database, poll: RadioPollRow): RadioPollExportDataset {
  const results = pollResults(db, poll);
  return {
    pollId: poll.id,
    name: poll.name,
    createdAt: poll.created_at,
    engineVersion: poll.engine_version,
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
      weights: s.weights,
      candidates: s.candidates.map(exportCandidate),
    })),
  };
}
