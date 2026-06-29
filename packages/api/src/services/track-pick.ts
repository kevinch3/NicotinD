import { normalizeTitle, stripTitleQualifiers, titlesOverlap } from './album-hunter.service.js';

/**
 * Pure "pick the healthiest, cleanest file for a track" logic, shared by the
 * cross-peer album fallback and the user-facing track hunter (§F2/§C1). Kept
 * free of slskd/IO so it's unit-testable in isolation.
 */

/**
 * Ordered, de-duped slskd query variants for a single track. why: a single
 * `"<artist> <title>"` search is silently soft-banned for many phrases (the same
 * server-side ban the album hunter's skew-search bypasses), so a lone query loses
 * most tracks. We try progressively skewed forms until one returns a hit:
 *   1. `"<artist> <title>"`            — the exact phrase.
 *   2. `"<title>"`                     — drop the artist (bypasses artist-phrase bans).
 *   3. `"<artist-truncated> <title>"`  — drop the artist's last char (the documented
 *                                        Spanish/Portuguese per-name ban bypass).
 *   4. `"<artist> <stripped-title>"`   — drop `(feat…)`/`(Remaster…)` qualifiers the
 *                                        peer's filename usually omits.
 * Empty/duplicate variants are dropped, so a single-word artist or a qualifier-free
 * title simply yields fewer queries.
 */
export function buildTrackQueries(artist: string, title: string): string[] {
  const a = artist.trim();
  const t = title.trim();
  const truncated = a.length > 3 ? a.slice(0, -1) : '';
  const stripped = stripTitleQualifiers(t);
  const variants = [
    `${a} ${t}`,
    t,
    truncated ? `${truncated} ${t}` : '',
    stripped && stripped !== t ? `${a} ${stripped}` : '',
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of variants) {
    const q = v.trim().replace(/\s+/g, ' ');
    if (!q || seen.has(q)) continue;
    seen.add(q);
    out.push(q);
  }
  return out;
}

const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.flac', '.ogg', '.opus', '.m4a', '.aac', '.wav', '.aiff', '.wma', '.ape', '.wv',
]);

export interface SearchResponseLike {
  username: string;
  freeUploadSlots?: number;
  queueLength?: number;
  uploadSpeed?: number;
  files: Array<{ filename: string; size: number; bitRate?: number; length?: number }>;
}

export interface TrackPick {
  username: string;
  file: { filename: string; size: number };
}

/** Free slot dominates, then short queue, then speed — a peer-health proxy. */
export function healthScore(r: {
  freeUploadSlots?: number;
  queueLength?: number;
  uploadSpeed?: number;
}): number {
  const slots = (r.freeUploadSlots ?? 0) > 0 ? 1000 : 0;
  const queuePenalty = Math.min(r.queueLength ?? 0, 999);
  const speed = (r.uploadSpeed ?? 0) / 1_000_000;
  return slots - queuePenalty + speed;
}

export function normalizeBasename(filename: string): string {
  const base = filename.replace(/\\/g, '/').split('/').pop() ?? filename;
  const noExt = base.slice(0, base.lastIndexOf('.') || base.length);
  return normalizeTitle(noExt);
}

/**
 * How many words a candidate filename has beyond the canonical track title — a
 * proxy for version/edition noise ("(5.1 mix)", "(remastered)"). 0 = exact.
 */
export function extraTokenCount(canonicalNorm: string, fileNorm: string): number {
  const canon = new Set(canonicalNorm.split(' ').filter(Boolean));
  return fileNorm
    .split(' ')
    .filter(Boolean)
    .reduce((n, w) => (canon.has(w) ? n : n + 1), 0);
}

function fileExt(filename: string): string {
  return filename.slice(filename.lastIndexOf('.')).toLowerCase();
}

/**
 * Choose the single best file matching `title` across all peer responses.
 * Cleanliness dominates (fewest extra words beyond the title), so we get
 * "Bohemian Rhapsody" not the "(5.1 mix)" a healthy FLAC peer would otherwise
 * win on; FLAC + peer health only break ties among equally-clean files.
 */
export function pickBestTrackFile(
  responses: SearchResponseLike[],
  title: string,
): TrackPick | null {
  const normTitle = normalizeTitle(title);
  // Qualifier-stripped core ("Song (feat. X)" → "Song"): peers routinely name a
  // file without the Lidarr title's "(feat…)"/"(Remasterizado)" suffix, so the full
  // titles never overlap. Falling back to the core rescues those near-hits (same
  // idea as `singleMatchStrength` in the album hunter). null when the core adds
  // nothing, so we never loosen matching for already-bare titles.
  const core = stripTitleQualifiers(title);
  const normCore = core && core !== title ? normalizeTitle(core) : null;
  let best: { username: string; file: { filename: string; size: number }; extras: number; score: number } | null =
    null;

  for (const response of responses) {
    const peerScore = healthScore(response);
    for (const file of response.files) {
      const ext = fileExt(file.filename);
      if (!AUDIO_EXTENSIONS.has(ext)) continue;
      const normFile = normalizeBasename(file.filename);
      const matchKey = titlesOverlap(normTitle, normFile)
        ? normTitle
        : normCore && titlesOverlap(normCore, normFile)
          ? normCore
          : null;
      if (!matchKey) continue;

      const extras = extraTokenCount(matchKey, normFile);
      const score = peerScore + (ext === '.flac' ? 1 : 0);
      if (!best || extras < best.extras || (extras === best.extras && score > best.score)) {
        best = {
          username: response.username,
          file: { filename: file.filename, size: file.size },
          extras,
          score,
        };
      }
    }
  }

  return best ? { username: best.username, file: best.file } : null;
}
