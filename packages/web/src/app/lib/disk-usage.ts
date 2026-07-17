/**
 * Pure helpers behind the Downloads storage pill (app-disk-pill).
 *
 * Formats byte counts for a compact "used / total" label and maps a fill ratio
 * (0..1) to a green→amber→red colour, so the pill reddens as the disk fills.
 * Kept DI-free so they're unit-testable without instantiating the component
 * (the web JIT harness can't drive input() signals).
 */

/** Format a byte count as a compact human string, e.g. 102005473280 -> "95 GB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 GB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // No decimals for B/KB/MB (whole units read cleaner); one for GB+.
  const decimals = unit >= 3 && value < 100 ? 1 : 0;
  return `${value.toFixed(decimals)} ${units[unit]}`;
}

/** Clamp used/total into a 0..1 fill ratio (0 when total is unknown). */
export function usedRatio(used: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(1, Math.max(0, used / total));
}

/**
 * Map a 0..1 fill ratio to a hue-rotated colour: green (~140°) when empty →
 * amber (~50°) mid → red (0°) when full. Returned as an `hsl()` string usable
 * directly in a `[style.background]` binding.
 */
export function diskFillColor(ratio: number): string {
  const r = Math.min(1, Math.max(0, ratio));
  // Interpolate hue 140 (green) down to 0 (red) as the disk fills.
  const hue = 140 * (1 - r);
  return `hsl(${Math.round(hue)}, 70%, 45%)`;
}
