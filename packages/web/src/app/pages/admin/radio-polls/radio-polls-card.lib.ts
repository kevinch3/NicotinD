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
