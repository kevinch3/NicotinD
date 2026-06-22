import { parseYearFromFolder } from '@nicotind/core';

/**
 * Offline album-year recovery — fills `library_albums.year` for albums missing it
 * using only signals already on the machine (no Lidarr / live MusicBrainz):
 *   1. **tag**       — a year already on the album's song tags (`library_songs.year`).
 *   2. **folder**    — a year in the album folder name (`parseYearFromFolder`), the
 *                      reliable signal for comps ("Max Mix 2015", "… (2001)").
 *   3. **mb-cache**  — the release date of the matching recording in the existing
 *                      `mb-cache.json` (built by a prior normalize-library run).
 *
 * Pure & dependency-light so the picking logic is unit-testable; the script
 * (scripts/backfill-years.ts) gathers the signals and applies each pick through
 * the reversible `applyMetadataFix` (override + canonical update, survives rescans).
 */

export type YearSource = 'tag' | 'folder' | 'mb-cache';

export interface YearSignals {
  /** Years found on the album's song tags. */
  tagYears: number[];
  /** Year parsed from the album folder name, if any. */
  folderYear: number | null;
  /** Release years resolved from the MB cache for the album's recordings. */
  mbYears: number[];
}

export interface YearPick {
  year: number;
  source: YearSource;
}

const MIN_YEAR = 1900;
const MAX_YEAR = new Date().getFullYear() + 1;

function plausible(y: number): boolean {
  return Number.isInteger(y) && y >= MIN_YEAR && y <= MAX_YEAR;
}

/** Most frequent value; ties broken by the **earliest** year (prefer the original release). */
export function modeYear(years: number[]): number | null {
  const counts = new Map<number, number>();
  for (const y of years) if (plausible(y)) counts.set(y, (counts.get(y) ?? 0) + 1);
  let best: number | null = null;
  let bestCount = 0;
  for (const [y, c] of counts) {
    if (c > bestCount || (c === bestCount && best !== null && y < best)) {
      best = y;
      bestCount = c;
    }
  }
  return best;
}

/**
 * Choose a year from the available signals, highest-confidence first:
 * the file's own tag, then the folder-name year (great for comps), then the
 * MB-cache release year. Returns null when nothing plausible is available.
 */
export function pickAlbumYear(signals: YearSignals): YearPick | null {
  const tag = modeYear(signals.tagYears);
  if (tag) return { year: tag, source: 'tag' };
  if (signals.folderYear && plausible(signals.folderYear)) {
    return { year: signals.folderYear, source: 'folder' };
  }
  const mb = modeYear(signals.mbYears);
  if (mb) return { year: mb, source: 'mb-cache' };
  return null;
}

/** Re-export so the script and tests share one folder-year parser. */
export function folderYear(folderName: string): number | null {
  const y = parseYearFromFolder(folderName);
  return y && plausible(y) ? y : null;
}

/**
 * Normalize an artist/title to the `mb-cache.json` key form
 * (`recording:<artist>|<title>`), diacritic-folded and punctuation-stripped.
 */
export function mbCacheKey(artist: string, title: string): string {
  const norm = (s: string): string =>
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9| ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  return `recording:${norm(artist)}|${norm(title)}`;
}

/** Pull a 4-digit release year out of one mb-cache entry, or null. */
export function mbCacheYear(entry: unknown): number | null {
  const date = (entry as { result?: { release?: { date?: string } } })?.result?.release?.date;
  if (!date) return null;
  const y = Number(String(date).slice(0, 4));
  return plausible(y) ? y : null;
}
