import { keyToCamelot } from './key-detection.js';

export interface SongFeatures {
  bpm?: number;
  key?: string;
  /** Primary genre (single-value compat; used when `genres` is absent). */
  genre?: string;
  /** Full genre set (primary first). When present it drives the genre axis. */
  genres?: string[];
  duration: number;
  year?: number;
  artistId: string;
  /** Perceptual features (0..1), filled by the enrichment tasks. Optional —
   *  scoring only counts an axis when BOTH sides carry it (see scoreSimilarity). */
  energy?: number;
  valence?: number;
  danceability?: number;
  instrumental?: number;
  acousticness?: number;
  /** Cached Essentia embedding (from `library_embeddings`), attached by the
   *  route layer via `loadEmbeddings`. Scored as an extra closeness axis when
   *  both seed and candidate carry one of matching dimensionality. */
  embedding?: Float32Array;
}

export interface ScoringWeights {
  genre: number;
  bpm: number;
  key: number;
  year: number;
  duration: number;
  /** Same-artist adjustment applied in NORMALIZED (0..1) space after the fit
   *  score is computed: `final = base - artistPenalty` when artists match.
   *  Positive = penalize repeats (radio); negative = boost (similar). */
  artistPenalty: number;
  energy: number;
  valence: number;
  danceability: number;
  instrumental: number;
  acousticness: number;
  embedding: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  // Relative weights of each comparable axis. Since scoreSimilarity normalizes
  // by the sum of weights of the axes both tracks actually share, only the
  // *ratios* matter for a single seed — an un-analyzed candidate competes on the
  // axes it has instead of being penalized for un-measured ones.
  //
  // genre 10 -> 18 (issue #187 task B3): measured via dump-radio.ts --weights
  // across 10 real seeds (well-tagged controls + random + a sparse-pool niche
  // seed). 9/10 seeds already showed 0 "genre lost on weight" at 10 — the
  // missing-genre floor (B2) had already closed most of the gap B3 targeted.
  // But a niche/sparse-catalogue seed (a Folktronica pool sharing genre tokens
  // with only 15% of the candidate pool) still let 4/12 wrong-genre tracks
  // outrank real neighbours on other-axis strength alone; 18 was the smallest
  // value in the tested 10/14/16/18 sweep that fully closed it (0/12), with no
  // change on any of the other 9 seeds at any tested value — see docs/radio.md
  // "Genre weight re-measure (task B3)".
  genre: 18,
  bpm: 8,
  key: 6,
  year: 2,
  duration: 1,
  // Perceptual axes. Energy leads (it defines the "momentum" of a set);
  // valence shapes the mood arc; the rest refine.
  energy: 5,
  valence: 4,
  danceability: 3,
  instrumental: 3,
  acousticness: 2,
  // Cached embedding cosine — overlaps the 5 scalar axes (they are classifier
  // heads over the same vector) so it's an augment, weighted modestly.
  embedding: 4,
  // Applied post-normalization as a delta on the 0..1 fit score.
  artistPenalty: 0.15,
};

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** 1 − |a − b| over a 0..1 domain; null when either side is missing (so the
 *  axis is skipped — contributes to neither numerator nor denominator). */
function unitCloseness(a: number | undefined, b: number | undefined): number | null {
  if (a === undefined || b === undefined) return null;
  return clamp01(1 - Math.abs(a - b));
}

/** Cosine similarity of two equal-length vectors in [−1, 1]; null when either
 *  is absent, empty, or of a different dimension (can't compare). */
export function cosineSim(a?: Float32Array, b?: Float32Array): number | null {
  if (!a || !b || a.length === 0 || a.length !== b.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return null;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Lexical genre closeness in [0, 1] — case-fold + tokenized, no external map.
 * Exact (case-insensitive) → 1.0; one token-set a superset of the other
 * (e.g. "deep house" ⊇ "house") → 0.6; otherwise Jaccard-scaled up to 0.5;
 * disjoint → 0. Returns null when either side is blank (axis skipped).
 */
export function genreCloseness(a: string | undefined, b: string | undefined): number | null {
  if (!a || !b) return null;
  const na = a.trim().toLowerCase();
  const nb = b.trim().toLowerCase();
  if (!na || !nb) return null;
  if (na === nb) return 1.0;
  const ta = new Set(na.split(/[^a-z0-9]+/).filter(Boolean));
  const tb = new Set(nb.split(/[^a-z0-9]+/).filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  if (inter === 0) return 0;
  // One set fully contained in the other → strong partial credit.
  if (inter === ta.size || inter === tb.size) return 0.6;
  // Otherwise Jaccard, scaled so a partial overlap can't beat containment.
  const jaccard = inter / (ta.size + tb.size - inter);
  return clamp01(jaccard) * 0.5;
}

/**
 * Genre closeness over full genre SETS: the best (max) pairwise lexical
 * closeness between the two sides. A shared secondary genre thus scores as
 * well as a shared primary — the whole point of multi-genre for radio.
 * Accepts a single string for single-genre compat. Null when either side is
 * empty (axis skipped), matching genreCloseness semantics.
 */
export function genreSetCloseness(
  a: string | string[] | undefined,
  b: string | string[] | undefined,
): number | null {
  const la = (Array.isArray(a) ? a : a == null ? [] : [a]).filter(Boolean);
  const lb = (Array.isArray(b) ? b : b == null ? [] : [b]).filter(Boolean);
  if (la.length === 0 || lb.length === 0) return null;
  let best: number | null = null;
  for (const ga of la) {
    for (const gb of lb) {
      const c = genreCloseness(ga, gb);
      if (c !== null && (best === null || c > best)) best = c;
      if (best === 1) return 1;
    }
  }
  return best;
}

export function camelotCompatibility(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  const numA = parseInt(a, 10);
  const numB = parseInt(b, 10);
  const ringA = a.slice(-1);
  const ringB = b.slice(-1);
  if (isNaN(numA) || isNaN(numB)) return 0;

  // Circular distance on the 12-hour wheel (1↔12 wrap).
  const rawDiff = Math.abs(numA - numB);
  const numDiff = Math.min(rawDiff, 12 - rawDiff);
  const sameRing = ringA === ringB;

  if (numDiff === 0 && sameRing) return 1.0;
  // Same number, different ring (A↔B swap) — relative minor/major
  if (numDiff === 0) return 0.8;
  if (sameRing) {
    if (numDiff === 1) return 0.7; // adjacent — energy shift
    if (numDiff === 2) return 0.4; // ±2 — bigger energy jump, still mixable
  } else if (numDiff === 1) {
    return 0.4; // diagonal move (±1 number + ring swap)
  }
  return 0;
}

/** One comparable axis in a similarity breakdown: its 0..1 closeness `value`,
 *  the `weight` it carried, and `contribution = value × weight`. */
export interface AxisContribution {
  axis: string;
  value: number;
  weight: number;
  contribution: number;
}

/** Per-axis explanation of a similarity score — the diagnostic seam behind
 *  `dump-radio.ts`. `axes` are the axes BOTH sides carried (so they counted);
 *  `skipped` names the axes dropped because one side lacked the feature. The
 *  distinction is the whole point: a genre in `axes` with value 0 is a *weighting*
 *  loss (disjoint tags), whereas `"genre"` in `skipped` is a *data* gap (untagged
 *  track) — two very different fixes. */
export interface SimilarityExplanation {
  score: number;
  axes: AxisContribution[];
  skipped: string[];
  /** Axes scored at a floor because the *candidate* lacked the data while the
   *  seed had it (today: `genre`). They appear in `axes` too — this list is what
   *  lets the diagnostic still separate a data gap from a genuine weak match. */
  floored: string[];
  artistPenaltyApplied: boolean;
}

/**
 * Score a genre-less candidate at this floor rather than skipping the axis.
 *
 * Skipping dropped the (heavily-weighted) genre axis out of the normalization denominator,
 * so an untagged track competed on BPM/energy alone and could out-rank a real
 * genre neighbour — missing data was literally *rewarded* (13% of the library has
 * no genre). A floor degrades gracefully instead: an untagged track is neither
 * excluded nor treated as a match. Deliberately non-zero so a mid-backfill
 * library stays discoverable.
 */
export const MISSING_GENRE_FLOOR = 0.2;

/**
 * Pure, IO-free per-axis breakdown of `scoreSimilarity`. `scoreSimilarity`
 * delegates to this (single source of truth for the axis math); the extra
 * `axes`/`skipped` detail it records is what the radio diagnostic dump reads to
 * tell genre-mismatch (weight problem) apart from missing-genre (data problem).
 * See docs/radio.md "Diagnostic dump".
 */
export function explainSimilarity(
  seed: SongFeatures,
  candidate: SongFeatures,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): SimilarityExplanation {
  // Accumulate a weighted numerator and the weight of the axes that are
  // actually comparable (both sides present), then normalize. An axis missing
  // on either side is skipped entirely, so an un-analyzed candidate competes on
  // the axes it has rather than being dragged down by un-measured features.
  let scoreAcc = 0;
  let weightAcc = 0;
  const axes: AxisContribution[] = [];
  const skipped: string[] = [];
  const floored: string[] = [];
  const add = (axis: string, value: number | null, weight: number): void => {
    if (value === null) {
      skipped.push(axis);
      return;
    }
    if (weight === 0) return;
    scoreAcc += value * weight;
    weightAcc += weight;
    axes.push({ axis, value, weight, contribution: value * weight });
  };

  // Genre: best pairwise lexical closeness across the two genre sets (falls
  // back to the single primary when a side has no set). When the seed has genre
  // data and the candidate does not, the axis is FLOORED rather than skipped —
  // see MISSING_GENRE_FLOOR. A seed with no genre still skips (nothing to
  // compare), and no other axis floors: an un-analyzed candidate must not be
  // penalized for un-measured bpm/key/perceptual features.
  const seedGenre = seed.genres ?? seed.genre;
  const candGenre = candidate.genres ?? candidate.genre;
  const genreValue = genreSetCloseness(seedGenre, candGenre);
  const seedHasGenre = (Array.isArray(seedGenre) ? seedGenre.filter(Boolean).length > 0 : !!seedGenre);
  if (genreValue === null && seedHasGenre) {
    floored.push('genre');
    add('genre', MISSING_GENRE_FLOOR, weights.genre);
  } else {
    add('genre', genreValue, weights.genre);
  }

  // BPM proximity: ±5% ≈ near-full score, scaled linearly.
  add(
    'bpm',
    seed.bpm && candidate.bpm && seed.bpm > 0
      ? clamp01(1 - (Math.abs(seed.bpm - candidate.bpm) / seed.bpm) * 5)
      : null,
    weights.bpm,
  );

  // Harmonic key compatibility via Camelot wheel.
  add(
    'key',
    seed.key && candidate.key
      ? camelotCompatibility(keyToCamelot(seed.key), keyToCamelot(candidate.key))
      : null,
    weights.key,
  );

  // Year proximity: ±20 years scaled.
  add(
    'year',
    seed.year && candidate.year ? clamp01(1 - Math.abs(seed.year - candidate.year) / 20) : null,
    weights.year,
  );

  // Duration similarity: scaled against seed duration.
  add(
    'duration',
    seed.duration > 0 && candidate.duration > 0
      ? clamp01(1 - Math.abs(seed.duration - candidate.duration) / seed.duration)
      : null,
    weights.duration,
  );

  // Perceptual axes (0..1 domains) — only when BOTH sides carry the feature.
  add('energy', unitCloseness(seed.energy, candidate.energy), weights.energy);
  add('valence', unitCloseness(seed.valence, candidate.valence), weights.valence);
  add('danceability', unitCloseness(seed.danceability, candidate.danceability), weights.danceability);
  add('instrumental', unitCloseness(seed.instrumental, candidate.instrumental), weights.instrumental);
  add('acousticness', unitCloseness(seed.acousticness, candidate.acousticness), weights.acousticness);

  // Cached embedding cosine, mapped from [−1,1] to [0,1] closeness.
  const cos = cosineSim(seed.embedding, candidate.embedding);
  add('embedding', cos === null ? null : (cos + 1) / 2, weights.embedding);

  const base = weightAcc > 0 ? scoreAcc / weightAcc : 0;

  // Same-artist adjustment in normalized space (penalty for radio, boost for
  // "similar"). The per-artist cap in rankCandidates remains the main lever.
  const artistPenaltyApplied = seed.artistId === candidate.artistId;
  const score = artistPenaltyApplied ? base - weights.artistPenalty : base;

  return { score, axes, skipped, floored, artistPenaltyApplied };
}

export function scoreSimilarity(
  seed: SongFeatures,
  candidate: SongFeatures,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): number {
  return explainSimilarity(seed, candidate, weights).score;
}

export interface ScoredSong<T> {
  song: T;
  score: number;
}

export function rankCandidates<T extends SongFeatures>(
  seed: SongFeatures,
  candidates: T[],
  opts: {
    weights?: ScoringWeights;
    maxPerArtist?: number;
    count?: number;
  } = {},
): ScoredSong<T>[] {
  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  const maxPerArtist = opts.maxPerArtist ?? 2;
  const count = opts.count ?? 10;

  const scored = candidates.map((song) => ({
    song,
    score: scoreSimilarity(seed, song, weights),
  }));

  scored.sort((a, b) => b.score - a.score);

  const result: ScoredSong<T>[] = [];
  const artistCounts = new Map<string, number>();

  for (const entry of scored) {
    if (result.length >= count) break;
    const aid = entry.song.artistId;
    const cur = artistCounts.get(aid) ?? 0;
    if (cur >= maxPerArtist) continue;
    artistCounts.set(aid, cur + 1);
    result.push(entry);
  }

  return result;
}
