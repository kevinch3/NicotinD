/**
 * Station ("vibe") membership grading for filter-seeded radio.
 *
 * WHY THIS EXISTS. A genre station pools every track carrying the tag anywhere
 * in its genre set, which makes membership boolean and the genre axis
 * *degenerate*: every candidate matched the filter, so `genreSetCloseness`
 * against the station genre returns 1.0 for all of them and the heaviest weight
 * in the blend (18 of ~66) discriminates nothing. What was left to order the
 * station was bpm/energy/duration closeness to the pool average — which is why
 * an "Electronic" station served mid-tempo Queen and Madonna tracks next to
 * Calvin Harris: they carry the tag and they sit near 128 BPM.
 *
 * The fix is to grade membership instead of testing it. Two signals, both from
 * data the library already stores:
 *
 *  - **Tag depth** — where the station's genre sits in the track's own ordered
 *    genre set (`library_song_genres.position`). A primary tag is a claim about
 *    what the track *is*; a fifth-position tag is a footnote.
 *  - **Artist share** — how much of that artist's landed catalogue carries the
 *    genre at all (the same number `artistGenreDistribution` renders as the
 *    artist genre radar). Calvin Harris is ~all Electronic; Queen is a rounding
 *    error.
 *
 * Neither alone is enough, and they are deliberately combined so **either can
 * carry a track**: a Madonna track whose *primary* genre is Electronic really is
 * an electronic record and should place mid-table, while a Queen track wearing
 * the tag third by an artist who is 3% Electronic should sink. A demotion, never
 * an exclusion — same stance as `MISSING_GENRE_FLOOR` and `artistPenalty`, and
 * for the same reason: a hard cut empties the pool on a niche genre.
 *
 * Pure and IO-free (peer of `radio.service.ts`); the DB reads live in
 * `genre-distribution.ts` (`artistGenreShares`) and the route.
 *
 * See docs/radio.md "Stations (filter-seeded radio)".
 */

import { genreKey } from './genre-split.js';

/**
 * Credit for the position at which a track carries the station's genre.
 * Index = position in the track's own genre set; anything deeper than the last
 * entry uses the last value (a 3rd tag and an 8th tag are equally footnotes).
 *
 * The gaps are deliberately wide: primary-vs-secondary is the distinction that
 * separates "this is a house record" from "this record has some synths on it",
 * and a narrow spread would be swamped by the other axes.
 *
 * The tail shape is **deliberately left alone**: on prod, five curves from
 * `[1,.8,.6,.5]` to `[1,.5,.2,.1]` moved the served top-10 by 0–2 of 10 across
 * all eight stations, because that window is drawn almost entirely from
 * primary-tagged tracks. Anything past index 0 only re-orders tracks that are
 * never served, so tuning it is unfalsifiable here.
 */
export const DEPTH_CREDIT: readonly number[] = [1, 0.7, 0.45];

/**
 * How the two signals split the axis. Even, on purpose: the per-track signal
 * (depth) and the per-artist prior (share) are both allowed to carry a
 * candidate on their own, which is what keeps a real electronic record by a
 * mostly-pop artist in the station.
 */
export const DEPTH_WEIGHT = 0.5;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Position of the shallowest station-genre match in a candidate's ordered genre
 * set, or null when it carries none of them.
 *
 * Matching is case/whitespace-insensitive exact equality via `genreKey` —
 * deliberately the same test the pool SQL used to select the candidate
 * (`genre IN (…)`), so grading can never disagree with membership. No lexical
 * closeness here: "House" does not partially match "Electronic" (there is no
 * genre taxonomy in this repo, and inventing one per-call would be a different,
 * much larger change — see docs/radio.md).
 */
export function matchedGenrePosition(
  candidateGenres: readonly string[] | undefined,
  stationGenres: readonly string[],
): number | null {
  if (!candidateGenres?.length || !stationGenres.length) return null;
  const wanted = new Set(stationGenres.map(genreKey));
  for (let i = 0; i < candidateGenres.length; i++) {
    const g = candidateGenres[i];
    if (g && wanted.has(genreKey(g))) return i;
  }
  return null;
}

/**
 * Tag-depth credit in 0..1, or null when the candidate carries none of the
 * station's genres (the caller decides what an unmatched track means — for the
 * radio pool it cannot happen, since the tag is what selected it).
 */
export function genreDepthScore(
  candidateGenres: readonly string[] | undefined,
  stationGenres: readonly string[],
): number | null {
  const pos = matchedGenrePosition(candidateGenres, stationGenres);
  if (pos === null) return null;
  return DEPTH_CREDIT[Math.min(pos, DEPTH_CREDIT.length - 1)] ?? 0;
}

/**
 * Blend tag depth with the artist's catalogue share into a 0..1 station
 * affinity — how *central* this track is to the station, as opposed to merely
 * tagged with it.
 *
 * `artistShare` is the fraction of the artist's landed tracks carrying the
 * station genre (`artistGenreShares`), used **raw**. v3 softened it through a
 * `SHARE_REFERENCE` of 0.5 — full marks for any artist at least half of whose
 * catalogue wears the tag — on the reasoning that a genuine genre artist is
 * rarely 100%. Measured on the real library that ceiling was the defect: it
 * tied 23–74% of every station pool at exactly 1.00, and since the served
 * top-10 is drawn from that tie, the axis scored a **standard deviation of
 * 0.000 inside the window a listener actually hears** on five of eight
 * stations. It gated the pool; it never ordered it. Raw share breaks the tie
 * (7–27% remain tied) at no cost to the design intent — see
 * docs/measurements/radio-stations-2026-08.md.
 */
export function stationAffinity(
  depth: number | null,
  artistShare: number | null | undefined,
): number {
  const d = depth ?? 0;
  return clamp01(DEPTH_WEIGHT * d + (1 - DEPTH_WEIGHT) * clamp01(artistShare ?? 0));
}

/** A pool member as the anchor builder needs it: its affinity and its vector. */
export interface AnchorMember {
  affinity: number;
  embedding?: Float32Array;
}

/**
 * Fraction of the embedding-carrying pool that defines the station's sound.
 * The anchor is built from the most-central members only — averaging the whole
 * tagged pool is what produced a target that neither Queen nor Calvin Harris
 * was near.
 *
 * Measured inert on prod: 0.2 through 1.0 all land within cos 0.987 of each
 * other and leave the served top-10 unchanged on eight of eight stations. Kept
 * at 0.4 because the anchor as a whole is not inert (it sits cos 0.93–0.97 from
 * the plain pool mean), but nobody should tune this number expecting an effect.
 */
export const ANCHOR_FRACTION = 0.4;

/** Never anchor on fewer than this many vectors — a 2-track mean is noise. */
export const ANCHOR_MIN_MEMBERS = 8;

/**
 * The station's audio target: an affinity-weighted, L2-normalised mean of the
 * most-central members' embeddings, or null when too few carry one.
 *
 * Two passes. The first mean is taken over the top `ANCHOR_FRACTION` by
 * affinity; the second **re-takes it over the half of those that actually sit
 * closest to it**. (On prod the trim moves the anchor by cos 0.97–0.99 and the
 * served top-10 by 0–1 of 10 — this library has no strongly bimodal chip. It is
 * kept for the library that does; the number to re-measure is in
 * docs/measurements/radio-stations-2026-08.md.) A tag like "Electronic" spans genuinely bimodal audio (an
 * ambient record and a festival banger both wear it), and a single mean of a
 * bimodal set lands in the empty space between the two modes — the same
 * "average of everything" failure the affinity grading exists to fix, one level
 * down. The trim pass settles the anchor into the denser of the two.
 *
 * Pure: callers attach the result as the scorer's seed embedding.
 */
export function anchorCentroid(members: readonly AnchorMember[]): Float32Array | null {
  const withVec = members
    .filter((m): m is AnchorMember & { embedding: Float32Array } => !!m.embedding?.length)
    .sort((a, b) => b.affinity - a.affinity);
  if (withVec.length === 0) return null;

  const dim = withVec[0]!.embedding.length;
  const sameDim = withVec.filter((m) => m.embedding.length === dim);

  const take = Math.max(ANCHOR_MIN_MEMBERS, Math.round(sameDim.length * ANCHOR_FRACTION));
  const central = sameDim.slice(0, Math.min(take, sameDim.length));

  const provisional = weightedMean(central, dim);
  if (!provisional) return null;
  if (central.length < ANCHOR_MIN_MEMBERS * 2) return provisional;

  // Trim pass: keep the half of the central members closest to the provisional
  // mean, so a bimodal tag settles on its denser mode instead of the gap.
  const byCloseness = central
    .map((m) => ({ m, cos: cosine(m.embedding, provisional) }))
    .sort((a, b) => b.cos - a.cos)
    .slice(0, Math.max(ANCHOR_MIN_MEMBERS, Math.floor(central.length / 2)))
    .map((e) => e.m);
  return weightedMean(byCloseness, dim) ?? provisional;
}

function weightedMean(
  members: readonly (AnchorMember & { embedding: Float32Array })[],
  dim: number,
): Float32Array | null {
  const acc = new Float64Array(dim);
  let weightSum = 0;
  for (const m of members) {
    if (m.embedding.length !== dim) continue;
    // Floor the weight so a zero-affinity member still contributes a little
    // rather than silently dropping out of a mean it was selected into.
    const w = Math.max(0.05, m.affinity);
    weightSum += w;
    for (let i = 0; i < dim; i++) acc[i] += m.embedding[i]! * w;
  }
  if (weightSum === 0) return null;

  let norm = 0;
  for (let i = 0; i < dim; i++) {
    acc[i] /= weightSum;
    norm += acc[i]! * acc[i]!;
  }
  if (norm === 0) return null;
  norm = Math.sqrt(norm);
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] = acc[i]! / norm;
  return out;
}

/** Cosine of two same-length vectors; 0 when either is degenerate. */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
