/**
 * Shared, pure predicates that classify a name as **library pollution** — the
 * junk artist/album values that DJ-pool and Various-Artists rips leave behind.
 * Single source of truth, reused by:
 *   - the **auditor** (`library-audit.ts`) to flag existing pollution, and
 *   - the **organizer** (`library-organizer.ts`) to reject it at ingest time,
 * so "existing and new patterns" are caught by the same rules.
 *
 * Pure & dependency-free (no DB, no IO) so they're trivially unit-testable.
 * For "is this an unknown/placeholder artist" use the existing `isUnknownLike`
 * (audio-tags) / `isPlaceholderArtist` (artwork-backfill) — these cover the
 * *additional* DJ-pool watermark + bare-number classes those miss.
 */

/** Fold accents + lowercase for keyword matching (keeps a normalized word form). */
function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Watermark keywords seen tagged as the "artist" by DJ-pool / batea / remix-pack
 * sources (e.g. "DJ KAIRUZ- SERVICIO ARG", "Batea Especial Casamientos + 50 Años",
 * "MUSICAUNO.COM"). Word-boundary matched on the accent-folded name. Conservative
 * on purpose — bare "DJ" is a legitimate artist prefix (DJ Snake), so only these
 * source-specific markers count, not "dj" alone.
 */
const WATERMARK_KEYWORDS = [
  'servicio arg',
  'servicio musical',
  'batea',
  'musicauno',
  'ftpdj',
  'dj pool',
  'remix pack',
  'remix factory',
  'acapella pack',
  'descargas',
  'mp3 download',
];

/** A bare domain token, e.g. "ftpdjemilio.com" / "musicauno.com" — never a real artist name. */
const DOMAIN_RE = /\b[a-z0-9][a-z0-9-]*\.(com|net|org|info|biz|io|fm|tv|us|ar|mx|es)\b/i;

/**
 * True when `name` looks like a DJ-pool / VA-source **watermark** rather than a
 * real artist or album: a bare domain (`*.com`) or one of the curated source
 * keywords. These flood the singles list (one source produced 212 singles in the
 * prod library) and never match a real catalog release.
 */
export function looksLikeSourceWatermark(name: string | undefined | null): boolean {
  if (!name) return false;
  if (DOMAIN_RE.test(name)) return true;
  const f = fold(name);
  return WATERMARK_KEYWORDS.some((kw) => f.includes(kw));
}

/**
 * True when `name` is a **bare number** or disc-track-number shape — the
 * mis-parsed tag where a disc/track number ("101" = disc 1 track 01, "12",
 * "02-03") became the artist or album title. Pure-numeric **artist** names are
 * always junk; for albums, callers should additionally require a single-track
 * album so a legitimately numeric album title (e.g. "1989", "21") isn't flagged.
 */
export function isNumericLikeName(name: string | undefined | null): boolean {
  if (!name) return false;
  const t = name.trim();
  // Bare number (1–4 digits), optional trailing separator: "101", "12.", "7)".
  if (/^\d{1,4}\s*[.)\-_]?$/.test(t)) return true;
  // Disc-track / range shape: "02-03", "1.05", "03,4,5,6".
  if (/^\d{1,2}\s*[-.,]\s*\d{1,2}(\s*,\s*\d{1,2})*$/.test(t)) return true;
  return false;
}
