/** Extracts the leaf folder name and strips audio quality/format tags. */
export function cleanFolderName(raw: string): string {
  const leaf = raw.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? raw;

  let cleaned = leaf.replace(/\s*\[[^\]]*\]/g, '');

  cleaned = cleaned.replace(
    /\s*\((FLAC|MP3|WAV|AAC|OGG|OPUS|AIFF|ALAC|WMA|APE|LOSSLESS)\)/gi,
    '',
  );

  cleaned = cleaned.trim().replace(/[\s\-_]+$/, '').trim();

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
