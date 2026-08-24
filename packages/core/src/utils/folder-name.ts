/** Extracts the leaf folder name and strips audio quality/format tags. */
export function cleanFolderName(raw: string): string {
  const leaf = raw.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? raw;

  let cleaned = leaf.replace(/\s*\[[^\]]*\]/g, '');

  cleaned = cleaned.replace(/\s*\((FLAC|MP3|WAV|AAC|OGG|OPUS|AIFF|ALAC|WMA|APE|LOSSLESS)\)/gi, '');

  cleaned = cleaned
    .trim()
    .replace(/[\s\-_]+$/, '')
    .trim();

  return cleaned || leaf;
}

/**
 * Pulls a 4-digit year (1900-2099) out of a folder name when one is present.
 * Prefers the last match so e.g. "Best of 90s 2024" → 2024, not 1990s.
 */
export function parseYearFromFolder(raw: string): number | undefined {
  const leaf = raw.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? raw;
  const matches = leaf.match(/\b(19|20)\d{2}\b/g);
  if (!matches || matches.length === 0) return undefined;
  const year = Number(matches[matches.length - 1]);
  return Number.isFinite(year) ? year : undefined;
}

/**
 * Folder names that are generic/technical containers rather than a release —
 * Soulseek peers routinely file under `music/`, `downloads/`, `CD1/`. Shared
 * (issue: it lived privately in the API's `path-inference` while the download
 * title chain needed exactly the same judgement) so the two can never drift
 * into disagreeing about what counts as a name.
 */
const GENERIC_FOLDER_NAMES = new Set([
  'src',
  'source',
  'downloads',
  'download',
  'music',
  'audio',
  'mp3',
  'flac',
  'wav',
  'm4a',
  'ogg',
  'aac',
  'misc',
  'mixed',
  'files',
  'shared',
  'uploads',
  'media',
  'new',
  'old',
  'temp',
  'tmp',
  'data',
  'unsorted',
  // slskd's own transfer dirs — peers routinely share straight out of them (#674)
  'complete',
  'incomplete',
]);

export function isGenericFolderName(folderName: string): boolean {
  const lower = folderName.toLowerCase().trim();
  if (lower.length <= 2) return true;
  if (GENERIC_FOLDER_NAMES.has(lower)) return true;
  // Pure numbers / disc markers ("01", "1", "CD1") name a part, not a release.
  if (/^(cd|disc|disk)?\s*\d{1,2}$/i.test(lower)) return true;
  return false;
}
