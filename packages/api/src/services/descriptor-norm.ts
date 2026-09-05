/**
 * Z-score constants for the descriptor blocks (radio formula v5, issue #642).
 *
 * Why fixed constants rather than pool-relative normalisation: the poll
 * harness replays frozen snapshots through `explainSimilarity`
 * (`radio-poll-eval.ts` `rescoreCandidate`), which must therefore stay
 * pool-independent — a score that depends on who else was in the pool cannot
 * be re-graded later. The constants are MEASURED, not assumed: produced by
 * `scripts/measure-descriptor-stats.ts` over the library's stored raw values
 * (`library_song_descriptors` keeps them un-normalised for exactly this
 * reason) and committed with their sample size and date below, so a
 * re-measurement is a one-line diff rather than a re-analysis.
 *
 * Why z-scores at all: raw MFCC coefficients differ by orders of magnitude
 * (mfcc_0 is ≈ −700, mfcc_12 ≈ ±2), so a cosine over raw values would be
 * decided by one coefficient.
 */

export interface FeatureNorm {
  mean: number;
  sd: number;
}

export type DescriptorNorm = Record<string, FeatureNorm>;

/**
 * Provenance of {@link DESCRIPTOR_NORM}; re-stamp when re-measured. First
 * measurement was taken mid-backfill (1,816 of 15,430 songs, newest-first
 * scan order — a recency-biased sample). Re-run the script once the backfill
 * completes; the stored values are raw, so that is a one-line diff.
 */
export const DESCRIPTOR_NORM_SAMPLE = {
  n: 1816,
  measuredAt: '2026-08-23',
  library: 'kpc (prod)',
};

// Scalars that are stored but not in any block (bpm, chords_changes_rate,
// dynamic_complexity, key_strength, loudness_range) are kept for completeness.
export const DESCRIPTOR_NORM: DescriptorNorm = {
  band_bass: { mean: 0.4624, sd: 0.1433 },
  band_high: { mean: 0.0179, sd: 0.0154 },
  band_high_mid: { mean: 0.0552, sd: 0.0435 },
  band_low_mid: { mean: 0.1338, sd: 0.0811 },
  band_mid: { mean: 0.2235, sd: 0.1299 },
  band_sub_bass: { mean: 0.1073, sd: 0.1103 },
  beat_strength: { mean: 0.0609, sd: 0.0492 },
  bpm: { mean: 120.6603, sd: 21.6859 },
  chords_changes_rate: { mean: 0.0623, sd: 0.0223 },
  danceability_dsp: { mean: 1.2818, sd: 0.2847 },
  dynamic_complexity: { mean: 3.7471, sd: 1.671 },
  groove_regularity: { mean: 0.9211, sd: 0.0376 },
  key_strength: { mean: 0.6971, sd: 0.1079 },
  kick_weight: { mean: 0.5121, sd: 0.1793 },
  loudness_range: { mean: 5.8612, sd: 3.5021 },
  mfcc_0: { mean: -686.8234, sd: 59.0838 },
  mfcc_1: { mean: 130.1991, sd: 33.0084 },
  mfcc_10: { mean: -0.9071, sd: 4.6341 },
  mfcc_11: { mean: -0.4755, sd: 4.1699 },
  mfcc_12: { mean: -1.2199, sd: 3.8608 },
  mfcc_2: { mean: 11.7061, sd: 21.3532 },
  mfcc_3: { mean: 20.7664, sd: 11.7995 },
  mfcc_4: { mean: 5.9858, sd: 9.3792 },
  mfcc_5: { mean: 3.4782, sd: 9.169 },
  mfcc_6: { mean: 0.9528, sd: 7.2202 },
  mfcc_7: { mean: 2.5723, sd: 6.2371 },
  mfcc_8: { mean: -0.9035, sd: 5.9156 },
  mfcc_9: { mean: 1.6699, sd: 4.9255 },
  onset_rate: { mean: 4.1666, sd: 1.0875 },
  pitch_salience: { mean: 0.5087, sd: 0.0615 },
  spectral_bandwidth: { mean: 4933941.3397, sd: 1229877.9302 },
  spectral_centroid: { mean: 1194.7651, sd: 411.7395 },
  spectral_complexity: { mean: 15.0513, sd: 5.3567 },
  spectral_flatness: { mean: 0.1794, sd: 0.0602 },
  spectral_flux: { mean: 0.0858, sd: 0.0213 },
  spectral_rolloff: { mean: 1449.8222, sd: 664.3838 },
  swing_ratio: { mean: 0.5176, sd: 0.0526 },
  syncopation: { mean: 0.2209, sd: 0.0988 },
  tempo_stability: { mean: 0.7186, sd: 0.328 },
  zero_crossing_rate: { mean: 0.058, sd: 0.0212 },
};
