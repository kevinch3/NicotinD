/**
 * The three composite descriptor axes of radio formula v5 (issue #642):
 * timbre, groove and spectral balance — each ONE pollable weight over a block
 * of the raw per-track descriptors (`library_song_descriptors`, phase 1).
 *
 * Why composites, not ~40 individual axes: `RADIO_FORMULA_VERSION` reached 4
 * after one calibration round of 70 votes. Forty free weights fitted from
 * seventy votes is overfitting, and v3 already showed a plausible constant
 * shipping wrong. Three blocks keep the formula measurable. Every raw value is
 * still stored, so a block can be decomposed later if the polls justify it.
 *
 * Pure and DB-free (the `station-affinity.ts` pattern): the route layer
 * attaches blocks the way it attaches embeddings; `explainSimilarity` calls
 * the closeness functions through the same `add()` so a missing block SKIPS —
 * an un-analysed candidate competes on the axes it has, exactly as today.
 */
import type { DescriptorFeatures } from './descriptor-store.js';
import { DESCRIPTOR_NORM, type DescriptorNorm } from './descriptor-norm.js';

/** Mirrors `DESCRIPTOR_NAMES` in packages/analysis/app/descriptors.py. */
export const TIMBRE_NAMES: readonly string[] = [
  ...Array.from({ length: 13 }, (_, i) => `mfcc_${i}`),
  'spectral_centroid',
  'spectral_bandwidth',
  'spectral_rolloff',
  'spectral_flux',
  'spectral_flatness',
  'spectral_complexity',
  'zero_crossing_rate',
  'pitch_salience',
];

export const GROOVE_NAMES: readonly string[] = [
  'onset_rate',
  'beat_strength',
  'tempo_stability',
  'swing_ratio',
  'groove_regularity',
  'syncopation',
  'danceability_dsp',
  'kick_weight',
];

export const BAND_NAMES: readonly string[] = [
  'band_sub_bass',
  'band_bass',
  'band_low_mid',
  'band_mid',
  'band_high_mid',
  'band_high',
];

export interface DescriptorBlocks {
  /** 21 z-scores. */
  timbre?: number[];
  /** 8 z-scores. */
  groove?: number[];
  /** 6 shares summing to 1 (raw — the scale IS the signal). */
  bands?: number[];
}

/** A block with more than this share of missing values is not comparable. */
const MAX_MISSING_SHARE = 0.5;

function zBlock(
  features: DescriptorFeatures,
  names: readonly string[],
  norm: DescriptorNorm,
): number[] | undefined {
  let missing = 0;
  const out = names.map((name) => {
    const v = features[name];
    if (v === null || v === undefined || !Number.isFinite(v)) {
      missing++;
      return 0; // the population mean — neutral, never a hole
    }
    const n = norm[name];
    if (!n || !(n.sd > 0)) return 0; // unmeasured or constant feature: no information
    return (v - n.mean) / n.sd;
  });
  return missing / names.length > MAX_MISSING_SHARE ? undefined : out;
}

/** Raw stored features → the three scoring blocks. */
export function descriptorBlocks(
  features: DescriptorFeatures,
  norm: DescriptorNorm = DESCRIPTOR_NORM,
): DescriptorBlocks {
  const bands = BAND_NAMES.map((n) => features[n]);
  return {
    timbre: zBlock(features, TIMBRE_NAMES, norm),
    groove: zBlock(features, GROOVE_NAMES, norm),
    bands: bands.every((v): v is number => typeof v === 'number' && Number.isFinite(v))
      ? bands
      : undefined,
  };
}

/**
 * Cosine closeness mapped to 0..1 (identical 1, orthogonal 0.5, opposite 0),
 * the same mapping the embedding axis uses. Null — the axis skips — when a
 * side is missing, empty, all-zero or mis-sized.
 */
export function blockCosineCloseness(
  a: number[] | undefined,
  b: number[] | undefined,
): number | null {
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
  const cos = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return (Math.max(-1, Math.min(1, cos)) + 1) / 2;
}

/**
 * `1 − L1/2` over band shares. L1 rather than cosine because the shares are a
 * distribution: cosine is scale-invariant precisely where the scale is the
 * signal (a bass-heavy and a bass-light track with the same spectral *shape*
 * would tie under cosine).
 */
export function spectralBalanceCloseness(
  a: number[] | undefined,
  b: number[] | undefined,
): number | null {
  if (!a || !b || a.length === 0 || a.length !== b.length) return null;
  let l1 = 0;
  for (let i = 0; i < a.length; i++) l1 += Math.abs(a[i]! - b[i]!);
  return Math.max(0, Math.min(1, 1 - l1 / 2));
}

/** Element-wise mean of the vectors present (filter radio's station centroid). */
export function meanBlock(vectors: (number[] | undefined)[]): number[] | undefined {
  const present = vectors.filter((v): v is number[] => Array.isArray(v) && v.length > 0);
  if (present.length === 0) return undefined;
  const dim = present[0]!.length;
  const same = present.filter((v) => v.length === dim);
  const out = new Array<number>(dim).fill(0);
  for (const v of same) for (let i = 0; i < dim; i++) out[i]! += v[i]!;
  return out.map((x) => x / same.length);
}
