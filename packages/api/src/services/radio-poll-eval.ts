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
 * measurable against votes collected before it — except two axes a snapshot
 * cannot reproduce, both read from the stored explanation instead:
 *   - embedding: the vector is stripped from snapshots (`stripFeatures`), so
 *     its frozen VALUE is folded into the weighted mean under the candidate
 *     weight set's embedding weight;
 *   - genre on a `genreAxis: 'learned'` scenario (#1121): the centroid store
 *     is not in the snapshot, so a recompute silently falls back to the
 *     LEXICAL rule and would grade a poll on a formula it never served. The
 *     frozen value REPLACES the recomputed one (unlike embedding, which is
 *     added — `explainSimilarity` does emit a genre axis, just a lexical one).
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

function storedAxisValue(explanation: unknown, axis: string): number | null {
  const axes = (explanation as { axes?: Array<{ axis?: string; value?: number }> } | null)?.axes;
  if (!Array.isArray(axes)) return null;
  const hit = axes.find((a) => a?.axis === axis);
  return typeof hit?.value === 'number' ? hit.value : null;
}

/**
 * Numerator correction that swaps the recomputed (lexical) genre value for the
 * learned one the poll actually served. 0 when there is nothing to swap — a
 * lexical scenario, a snapshot without a genre axis, or a recompute that
 * skipped genre entirely (nothing to weight the frozen value by).
 */
function frozenGenreDelta(
  ex: { axes: Array<{ axis: string; value: number; weight: number }> },
  explanation: unknown,
): number {
  const recomputed = ex.axes.find((a) => a.axis === 'genre');
  const frozen = storedAxisValue(explanation, 'genre');
  if (!recomputed || frozen === null) return 0;
  return (frozen - recomputed.value) * recomputed.weight;
}

/** Re-score one frozen candidate against its seed under `weights`. */
export function rescoreCandidate(
  seed: SongFeatures,
  candidate: ExportCandidate,
  weights: ScoringWeights,
  opts: { genreAxis?: 'lexical' | 'learned' } = {},
): number {
  const ex = explainSimilarity(seed, candidate.features as SongFeatures, weights);
  const contrib = ex.axes.reduce((s, a) => s + a.contribution, 0);
  const weightAcc = ex.axes.reduce((s, a) => s + a.weight, 0);
  const base = weightAcc > 0 ? contrib / weightAcc : 0;
  // Post-normalization deltas (artist penalty; recent-play is always 0 here —
  // snapshots are listener-less) carried over unchanged.
  const penalties = ex.score - base;
  const genreDelta = opts.genreAxis === 'learned' ? frozenGenreDelta(ex, candidate.explanation) : 0;
  const emb = storedAxisValue(candidate.explanation, 'embedding');
  if (emb === null || weights.embedding <= 0) {
    return genreDelta === 0 ? ex.score : (contrib + genreDelta) / weightAcc + penalties;
  }
  const den = weightAcc + weights.embedding;
  return (contrib + genreDelta + emb * weights.embedding) / den + penalties;
}

export interface PollAgreement {
  pollId: string;
  name: string;
  formulaVersion: string;
  /** Scale the votes were cast under — pairs from different scales are
   *  different objects and are never pooled (issue #800, same rule as #583). */
  voteScale: 'binary' | 'stars5';
  /** Strategy the poll was generated under; grouped like the two above. */
  strategy: string;
  scenarioCount: number;
  /** Candidates with a non-null consensus (binary) or ≥1 rating (stars5). */
  gradedCandidates: number;
  tally: AgreementTally;
  auc: number | null;
}

export function evaluatePollAgreement(
  dataset: RadioPollExportDataset,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): PollAgreement {
  // Older dataset files on disk predate the field — absent means binary.
  const voteScale = dataset.voteScale ?? 'binary';
  const tally: AgreementTally = { wins: 0, ties: 0, pairs: 0 };
  let graded = 0;
  for (const sc of dataset.scenarios) {
    // A station scenario has no seed song — it scores against the pool centroid
    // + anchor `buildFilterRadio` derived from the filter, which the export now
    // carries. Until it did, every station scenario was skipped here, so no
    // amount of station voting could ever move a measurement.
    const seedFeatures = sc.seed?.features ?? sc.centroid;
    if (!seedFeatures) continue;
    const seed = seedFeatures as SongFeatures;
    if (voteScale === 'stars5') {
      // Graded votes generalize the binary metric: every within-scenario pair
      // with UNEQUAL mean ratings is informative, which is exactly the signal
      // binary consensus threw away as ties (issue #800).
      const scored = sc.candidates
        .filter((c) => (c.meanRating ?? null) !== null && (c.ratingCount ?? 0) > 0)
        .map((c) => ({
          mean: c.meanRating as number,
          score: rescoreCandidate(seed, c, weights, { genreAxis: sc.genreAxis }),
        }));
      graded += scored.length;
      for (let i = 0; i < scored.length; i++) {
        for (let j = i + 1; j < scored.length; j++) {
          const a = scored[i]!;
          const b = scored[j]!;
          if (a.mean === b.mean) continue;
          const [hi, lo] = a.mean > b.mean ? [a, b] : [b, a];
          tally.pairs++;
          if (hi.score > lo.score) tally.wins++;
          else if (hi.score === lo.score) tally.ties++;
        }
      }
      continue;
    }
    const scored = sc.candidates.map((c) => ({
      consensus: c.consensus,
      score: rescoreCandidate(seed, c, weights, { genreAxis: sc.genreAxis }),
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
    voteScale,
    strategy: dataset.strategy ?? 'balanced',
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
