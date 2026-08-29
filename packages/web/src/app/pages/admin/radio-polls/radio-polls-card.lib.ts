import type { RadioPollExplanation } from '../../../../types/core';

/**
 * One-line per-axis score breakdown, same string shape as dump-radio.ts's
 * `breakdownLine` so an admin reading both surfaces reads one language:
 * `genre 0.85×18 · bpm 0.90×8  [skipped: valence]`.
 */
export function breakdownLine(explanation: RadioPollExplanation): string {
  const axes = explanation.axes
    .map((a) => `${a.axis} ${a.value.toFixed(2)}×${a.weight}`)
    .join(' · ');
  const skipped = explanation.skipped.length
    ? `  [skipped: ${explanation.skipped.join(', ')}]`
    : '';
  return `${axes}${skipped}`;
}

/** Share of up-votes, 0..1 — the tally bar's fill. Null when unvoted. */
export function approvalShare(up: number, down: number): number | null {
  const total = up + down;
  return total === 0 ? null : up / total;
}

/** Stars5 counterpart of the 👍/👎 chips: `★ 4.5 (12)`. Null when unrated. */
export function ratingSummary(meanRating: number | null, ratingCount: number): string | null {
  if (meanRating === null || ratingCount === 0) return null;
  return `★ ${meanRating.toFixed(1)} (${ratingCount})`;
}

/** A 1..5 mean as the tally bar's 0..1 fill. Null when unrated. */
export function ratingShare(meanRating: number | null): number | null {
  return meanRating === null ? null : (meanRating - 1) / 4;
}
