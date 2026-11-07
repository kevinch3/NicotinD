/**
 * Integer percents for a part-to-whole split that add up to exactly 100, by
 * largest remainder — independent `Math.round` gives 99 or 101 often enough that
 * a "sums to 100%" chart visibly does not (#1670). Ties go to the earlier entry;
 * an all-zero input stays all zeros.
 */
export function sharePercents(counts: number[]): number[] {
  const total = counts.reduce((sum, n) => sum + n, 0);
  if (total <= 0) return counts.map(() => 0);
  const exact = counts.map((n) => (n / total) * 100);
  const floors = exact.map(Math.floor);
  let left = 100 - floors.reduce((sum, n) => sum + n, 0);
  const order = exact
    .map((x, i) => ({ i, rem: x - Math.floor(x) }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] += 1;
    left -= 1;
  }
  return floors;
}
