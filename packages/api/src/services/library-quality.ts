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
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
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
 * Structural DJ-set / release-listing corruption (issue #679). Distinct from the
 * watermark rules above: nothing here is a *keyword* the source stamped on, it is
 * a whole **line of text** — a set tracklist entry or a release-listing row —
 * that landed in the artist or album tag wholesale. One curation session had to
 * undo a single such batch by hand with 7 merges; that is the cost this prevents.
 *
 * Every marker below is one a real artist or release title never carries:
 *   - a narration verb next to a quoted track title (`DJ plays Artist "Track"`),
 *   - a `b2b` credit *between* two acts (`Secret Cinema B2B Egbert`),
 *   - three or more ` - ` separators, which is a listing row rather than a name
 *     (`Artist - Title - Label - CatNum [Vol`).
 *
 * A single ` - ` is deliberately NOT a marker: "Artist - Title" in an artist tag
 * is indistinguishable from a hyphenated real name without already knowing the
 * artist, and guessing there would corrupt more than it fixes.
 */
const DJ_SET_NARRATION_RE = /\b(?:plays|playing|premieres?)\b/i;
const QUOTED_SEGMENT_RE = /["“”'‘’][^"“”'‘’]{2,}["“”'‘’]/;
/** `b2b` with a word on each side — a back-to-back set credit, not a name. */
const B2B_CREDIT_RE = /\S\s+b2b\s+\S/i;
const LIST_SEPARATOR = ' - ';

export function looksLikeDjSetTag(name: string | undefined | null): boolean {
  if (!name) return false;
  if (DJ_SET_NARRATION_RE.test(name) && QUOTED_SEGMENT_RE.test(name)) return true;
  if (B2B_CREDIT_RE.test(name)) return true;
  return name.split(LIST_SEPARATOR).length - 1 >= 3;
}

/**
 * The venue/date credit shape — `Artist @ Awakenings`, `Artist @ Club, 2019`.
 *
 * **Artist field only**, which is the whole reason it is a separate predicate
 * from `looksLikeDjSetTag`: "Live @ Wembley" is a perfectly real *album* title,
 * so applying this rule to albums would reject real releases. No artist is named
 * with a spaced `@`.
 */
const VENUE_CREDIT_RE = /^(.*\S)\s+@\s+\S/;

export function looksLikeVenueCredit(name: string | undefined | null): boolean {
  if (!name) return false;
  return VENUE_CREDIT_RE.test(name);
}

/**
 * The **recoverable** half: when one of these strings carries its real artist as
 * the leading credit, return that instead of making the caller drop the tag —
 * dropping strands the track in Unsorted and throws away the one fact the string
 * did contain. Returns null when there is nothing safe to recover.
 *
 * Ambiguity is never resolved by guessing: a `b2b` credit names **two** acts with
 * no basis for picking one, so it returns null and the caller drops the tag —
 * exactly the case a human should decide (issue #682).
 */
export function djSetArtistName(name: string | undefined | null): string | null {
  if (!name) return null;
  if (B2B_CREDIT_RE.test(name)) return null;

  const venue = name.match(VENUE_CREDIT_RE);
  if (venue) return plausibleArtistLead(venue[1]);

  if (DJ_SET_NARRATION_RE.test(name) && QUOTED_SEGMENT_RE.test(name)) {
    return plausibleArtistLead(name.split(DJ_SET_NARRATION_RE)[0]);
  }

  if (name.split(LIST_SEPARATOR).length - 1 >= 3) {
    return plausibleArtistLead(name.split(LIST_SEPARATOR)[0]);
  }
  return null;
}

/**
 * Accept a recovered lead only while it still looks like a name: non-empty, at
 * most 6 words, and not itself junk. A longer lead means the split landed
 * mid-sentence and recovery is not safe.
 */
function plausibleArtistLead(raw: string | undefined): string | null {
  const v = (raw ?? '').trim().replace(/\s+/g, ' ');
  if (!v || v.split(' ').length > 6) return null;
  if (looksLikeSourceWatermark(v) || isNumericLikeName(v)) return null;
  return v;
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
