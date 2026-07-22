/**
 * Pure helpers behind the compact usage pills (CPU/GPU/memory on the Admin
 * "Metrics" row, mirroring the existing `DiskPillComponent` on Downloads).
 *
 * Re-exports `formatBytes` / `usedRatio` / `diskFillColor` from
 * `lib/disk-usage.ts` so both pills share one canonical byte formatter +
 * one green-to-red colour mapper — a high-fill memory pill reds the same way
 * a high-fill disk pill does. Adds a `formatMb` helper the memory pill uses
 * for its secondary "process RSS" line (kept compact under 100 MB).
 */

export { formatBytes, diskFillColor } from './disk-usage';
export { usedRatio } from './disk-usage';

/** Format a byte count as a compact string in MB, e.g. 150_000_000 → "143 MB". */
export function formatMb(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 100) return `${Math.round(mb)} MB`;
  return `${mb.toFixed(0)} MB`;
}
