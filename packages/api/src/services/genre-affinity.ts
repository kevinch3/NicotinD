/**
 * Genre affinity — how close two genre *names* are, learned from the library's
 * own audio (issue: tech-house radio drifting into festival EDM).
 *
 * WHY THIS EXISTS. The radio genre axis (`genreSetCloseness`) is lexical: exact
 * name = 1.0, token containment = 0.6, else Jaccard, MAX over every pair. Two
 * failures fall out of that, both heard in real listening:
 *
 *  1. **A shared umbrella tag masks a specific mismatch.** "Electronic; Tech
 *     House" vs "Electronic; Big Room" is a perfect 1.0 — the MAX lands on
 *     "Electronic" — so a tech-house session drifts into big-room EDM, a
 *     transition no DJ would make.
 *  2. **Adjacent scenes score zero.** "Tech House" vs "Minimal Techno" share no
 *     token, so they are as far apart as "Tech House" and "Tango".
 *
 * The open-weight model the library already runs answers both: every analysed
 * track carries a discogs-effnet embedding (`library_embeddings`), so a genre
 * NAME can be summarised as the **centroid** of the tracks wearing it
 * (`genre-centroids.ts`, refreshed daily, cached in `library_genre_centroids`).
 * Two names are then as close as their centroids' cosine — "Tech House" lands
 * next to "Minimal Techno" and away from "Big Room" *if that is how the
 * library's tracks actually sound*, which is a measurement, not an opinion.
 *
 * The umbrella problem has its own signal in the same data: a tag whose
 * members disagree with each other ("Electronic" covers ambient and bangers)
 * has a diffuse centroid — low **coherence** (the mean cosine of members to
 * their centroid, which for unit vectors is simply the norm of their mean).
 * A match on a low-coherence tag is discounted (`breadthCredit`), so a shared
 * "Electronic" can no longer out-score a real neighbour.
 *
 * Pure and IO-free: this module never touches the DB. `genreSetCloseness`
 * consumes a {@link GenreAffinityFn} as a drop-in for the lexical pair score
 * and falls back to lexical whenever a side is unknown or too thin
 * (`MIN_MEMBERS`). Every constant below was a prior and is now calibrated on
 * the production library (#1119); each carries the measured number it came
 * from, and the `genre-affinity.ts` script reprints those distributions
 * (docs/genre-affinity.md "Measurements").
 */

import { cosineSim } from './radio.service.js';
import { genreKey } from './genre-split.js';

/** One genre name's audio summary, as stored in `library_genre_centroids`. */
export interface GenreCentroid {
  /** Display spelling. */
  genre: string;
  /** Embedding model the centroid lives in; only same-model centroids compare. */
  model: string;
  /** L2-normalised mean of the members' unit vectors. */
  vec: Float32Array;
  /** Analysed, eligible tracks carrying the tag. */
  members: number;
  /**
   * |mean of unit member vectors| in (0, 1]: 1 = every member sounds alike, and
   * the lower it is the more the tag is a catch-all. This IS the mean cosine of
   * the members to their centroid (for unit vectors the two are identical), so
   * it costs nothing beyond the mean itself.
   */
  coherence: number;
}

/** Centroids keyed by `genreKey` — what the store loads and this module reads. */
export type GenreCentroidMap = ReadonlyMap<string, GenreCentroid>;

/**
 * Pairwise affinity resolver handed to the scorer. `null` = "I don't know this
 * pair" — the caller falls back to the lexical `genreCloseness`.
 */
export type GenreAffinityFn = (a: string, b: string) => number | null;

/**
 * A centroid over fewer tracks than this is treated as absent: a 2-track mean
 * is noise, and the lexical rule is a better guess than noise. Same instinct as
 * `ANCHOR_MIN_MEMBERS` in station-affinity.ts, lower because a genre name only
 * needs to be *placed*, not to anchor a whole station.
 */
// why 5: measured, the 59 tags at 3-4 members do NOT behave — Celtic→Melodic
// House, Crossover Thrash→Neo Soul, Anarcho-Punk→New Wave 0.14 — and admitting
// them would *replace* a lexical fallback that gets several of them right.
export const MIN_MEMBERS = 5;

/**
 * Cosines between discogs-effnet centroids cluster high (everything is music),
 * so the raw cosine is rescaled: `(cos − COS_FLOOR) / (1 − COS_FLOOR)`, clamped.
 * A pair at or below the floor scores 0 — as unrelated as the lexical rule
 * would call a disjoint pair.
 */
// why 0.75: measured on 67,528 prod pairs. The floor belongs at the bottom of
// the *nearest-neighbour* distribution (min 0.796, p5 0.890), not of the
// all-pairs one (p10 0.439, p50 0.634) — below ~0.8 a pair is nobody's nearest
// neighbour, so a lower floor pays half credit to genuinely distant genres,
// which IS the drift. 0.75 clears every genre's best neighbour but two, and
// widens the tech-house good-vs-drift gap from 0.235 to 0.426.
export const COS_FLOOR = 0.75;

/**
 * Umbrella discount. `credit = 1 − BREADTH_DISCOUNT × (1 − coherenceNorm)`,
 * where `coherenceNorm` maps `[COHERENCE_LOW, COHERENCE_HIGH]` onto `[0, 1]`.
 * At 0.5 the most diffuse tag keeps half credit — enough that a library tagged
 * only with umbrellas ("Rock" everywhere) still clears `MISSING_GENRE_FLOOR`
 * (0.2) on an exact match, not enough for it to beat a real neighbour.
 */
// why 0.5 kept: at the measured band an umbrella exact match scores 0.500,
// well under the 0.872 a named neighbour gets — the condition for raising it
// does not fire.
export const BREADTH_DISCOUNT = 0.5;
// why 0.70 / 0.81: measured coherence over 368 usable prod centroids spans
// 0.658..0.953 (p10 0.708, p50 0.793). Every umbrella named in #1119 sits below
// 0.70 — Latin 0.665, Pop 0.672, Rock 0.682, World 0.682, Electronic 0.693 —
// and the leaf styles the axis exists to separate sit at or above 0.81 (Tech
// House 0.809, Minimal Techno 0.812, Deep House 0.817). The shipped 0.55..0.9
// band was outside the data on both ends: nothing reached the discount floor
// and everything above p90 saturated.
export const COHERENCE_LOW = 0.7;
export const COHERENCE_HIGH = 0.81;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Specificity credit for a match involving this genre, 1 − D .. 1. */
export function breadthCredit(c: Pick<GenreCentroid, 'coherence'>): number {
  const norm = clamp01((c.coherence - COHERENCE_LOW) / (COHERENCE_HIGH - COHERENCE_LOW));
  return clamp01(1 - BREADTH_DISCOUNT * (1 - norm));
}

/** Raw centroid cosine → 0..1 affinity band. */
export function rescaleCosine(cos: number): number {
  return clamp01((cos - COS_FLOOR) / (1 - COS_FLOOR));
}

/** A centroid usable for scoring: enough members to mean something. */
export function isUsableCentroid(c: GenreCentroid | undefined): c is GenreCentroid {
  return !!c && c.members >= MIN_MEMBERS && c.vec.length > 0;
}

export type GenrePairSource = 'exact' | 'centroid' | 'unknown';

export interface GenrePairExplanation {
  a: string;
  b: string;
  /** Final 0..1 affinity, or null when a side is unknown (lexical fallback). */
  affinity: number | null;
  source: GenrePairSource;
  /** Raw centroid cosine, when both sides have one in the same model. */
  cosine: number | null;
  /** Specificity credit applied (min over both sides). */
  credit: number | null;
  members: [number | null, number | null];
  coherence: [number | null, number | null];
}

/**
 * Full breakdown of one pair — the scorer uses `.affinity`, the diagnostic
 * script prints the rest. Symmetric in its inputs.
 */
export function explainGenrePair(
  a: string,
  b: string,
  centroids: GenreCentroidMap,
): GenrePairExplanation {
  const ka = genreKey(a);
  const kb = genreKey(b);
  const ca = centroids.get(ka);
  const cb = centroids.get(kb);
  const ua = isUsableCentroid(ca) ? ca : undefined;
  const ub = isUsableCentroid(cb) ? cb : undefined;
  const base: GenrePairExplanation = {
    a,
    b,
    affinity: null,
    source: 'unknown',
    cosine: null,
    credit: null,
    members: [ca?.members ?? null, cb?.members ?? null],
    coherence: [ca?.coherence ?? null, cb?.coherence ?? null],
  };

  if (ka === kb) {
    // An exact match on an umbrella is still a weak claim (failure 1). An
    // unknown exact match keeps the lexical 1.0 — nothing knows better.
    if (!ua) return { ...base, affinity: 1, source: 'exact', credit: 1, cosine: 1 };
    const credit = breadthCredit(ua);
    return { ...base, affinity: credit, source: 'exact', credit, cosine: 1 };
  }
  if (!ua || !ub || ua.model !== ub.model) return base;

  const cos = cosineSim(ua.vec, ub.vec);
  if (cos === null) return base;
  const credit = Math.min(breadthCredit(ua), breadthCredit(ub));
  return {
    ...base,
    affinity: clamp01(rescaleCosine(cos) * credit),
    source: 'centroid',
    cosine: cos,
    credit,
  };
}

/** The scorer-facing resolver over a loaded centroid map. */
export function makeGenreAffinity(centroids: GenreCentroidMap): GenreAffinityFn {
  return (a, b) => explainGenrePair(a, b, centroids).affinity;
}

/**
 * Rank a vocabulary against one genre — the "what would radio drift into from
 * here" view the diagnostic script prints. Unknown entries are omitted.
 */
export function rankNeighbours(
  genre: string,
  vocab: readonly string[],
  centroids: GenreCentroidMap,
  limit = 20,
): Array<{ genre: string; explanation: GenrePairExplanation }> {
  const self = genreKey(genre);
  return vocab
    .filter((g) => genreKey(g) !== self)
    .map((g) => ({ genre: g, explanation: explainGenrePair(genre, g, centroids) }))
    .filter((e) => e.explanation.affinity !== null)
    .sort((x, y) => (y.explanation.affinity ?? 0) - (x.explanation.affinity ?? 0))
    .slice(0, limit);
}
