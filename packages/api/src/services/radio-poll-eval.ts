/**
 * Offline agreement measurement: how well a similarity weight set orders the
 * radio polls' human verdicts (docs/radio-eval-polls.md "Export & digestion",
 * issue #583 — the ratchet that turns poll votes into a measured decision).
 *
 * The metric is within-scenario pairwise AUC: over every (consensus-good,
 * consensus-bad) candidate pair of one scenario, the share of pairs the weight
 * set scores in the human order (ties count half). 0.5 = random, 1.0 = every
 * graded pair ordered like the humans. Pairs never cross scenarios (scores are
 * only comparable against the same seed), and ungraded candidates (tie / zero
 * votes) contribute nothing — an ambiguous grade is worse than none.
 *
 * Axis values are RECOMPUTED from the frozen snapshot features via
 * `explainSimilarity`, so a formula change (e.g. the junk-genre fix) is
 * measurable against votes collected before it — except the embedding axis,
 * whose vector is stripped from snapshots (`stripFeatures`): its frozen VALUE
 * is read from the stored explanation and folded into the weighted mean under
 * the candidate weight set's embedding weight.
 *
 * Caveat (the CLI prints it too): polls only grade the top-K the *generating*
 * formula served (off-policy), so an AUC validates ordering among those
 * candidates, not pool selection.
 */
import {
  DEFAULT_WEIGHTS,
  explainSimilarity,
  type ScoringWeights,
  type SongFeatures,
} from './radio.service.js';
import type { RadioPollExportDataset } from './radio-poll-export.js';

export interface AgreementTally {
  wins: number;
  ties: number;
  pairs: number;
}

/** (wins + ties/2) / pairs, or null with nothing graded. */
export function agreementAuc(t: AgreementTally): number | null {
  return t.pairs > 0 ? (t.wins + t.ties / 2) / t.pairs : null;
}

type ExportCandidate = RadioPollExportDataset['scenarios'][number]['candidates'][number];

function storedEmbeddingValue(explanation: unknown): number | null {
  const axes = (explanation as { axes?: Array<{ axis?: string; value?: number }> } | null)?.axes;
  if (!Array.isArray(axes)) return null;
  const hit = axes.find((a) => a?.axis === 'embedding');
  return typeof hit?.value === 'number' ? hit.value : null;
}

/** Re-score one frozen candidate against its seed under `weights`. */
export function rescoreCandidate(
  seed: SongFeatures,
  candidate: ExportCandidate,
  weights: ScoringWeights,
): number {
  const ex = explainSimilarity(seed, candidate.features as SongFeatures, weights);
  const contrib = ex.axes.reduce((s, a) => s + a.contribution, 0);
  const weightAcc = ex.axes.reduce((s, a) => s + a.weight, 0);
  const base = weightAcc > 0 ? contrib / weightAcc : 0;
  // Post-normalization deltas (artist penalty; recent-play is always 0 here —
  // snapshots are listener-less) carried over unchanged.
  const penalties = ex.score - base;
  const emb = storedEmbeddingValue(candidate.explanation);
  if (emb === null || weights.embedding <= 0) return ex.score;
  const den = weightAcc + weights.embedding;
  return (contrib + emb * weights.embedding) / den + penalties;
}

export interface PollAgreement {
  pollId: string;
  name: string;
  formulaVersion: string;
  scenarioCount: number;
  /** Candidates with a non-null consensus (the graded population). */
  gradedCandidates: number;
  tally: AgreementTally;
  auc: number | null;
}

export function evaluatePollAgreement(
  dataset: RadioPollExportDataset,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): PollAgreement {
  const tally: AgreementTally = { wins: 0, ties: 0, pairs: 0 };
  let graded = 0;
  for (const sc of dataset.scenarios) {
    // Filter (centroid) scenarios carry no seed in the export; skip rather
    // than guess a seed to score against.
    if (!sc.seed) continue;
    const seed = sc.seed.features as SongFeatures;
    const scored = sc.candidates.map((c) => ({
      consensus: c.consensus,
      score: rescoreCandidate(seed, c, weights),
    }));
    graded += scored.filter((s) => s.consensus !== null).length;
    const good = scored.filter((s) => s.consensus === 'good');
    const bad = scored.filter((s) => s.consensus === 'bad');
    for (const g of good) {
      for (const b of bad) {
        tally.pairs++;
        if (g.score > b.score) tally.wins++;
        else if (g.score === b.score) tally.ties++;
      }
    }
  }
  return {
    pollId: dataset.pollId,
    name: dataset.name,
    formulaVersion: dataset.formulaVersion,
    scenarioCount: dataset.scenarios.length,
    gradedCandidates: graded,
    tally,
    auc: agreementAuc(tally),
  };
}

/** Sum per-poll tallies into one pooled measurement. */
export function pooledTally(results: PollAgreement[]): AgreementTally {
  return results.reduce<AgreementTally>(
    (acc, r) => ({
      wins: acc.wins + r.tally.wins,
      ties: acc.ties + r.tally.ties,
      pairs: acc.pairs + r.tally.pairs,
    }),
    { wins: 0, ties: 0, pairs: 0 },
  );
}
