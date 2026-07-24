/**
 * Pure formatter for raw Discogs artist bios (issue #213). The source `profile`
 * text is a BBCode-ish mishmash with embedded cross-references and URLs that
 * render as garbage if shown verbatim. The library stores the raw text once and
 * lets the web reformat on every render — so existing rows reformat without a
 * refetch, and a future server-side change can't leave rows stuck with the
 * old markup.
 *
 * Renderer-agnostic: returns plain text + extracted URLs. The caller
 * (the `ArtistInfoComponent` template) decides how to lay it out.
 *
 * What the formatter strips / extracts:
 *  - `[url=https://…]Label[/url]`     → `Label` (the visible label is kept)
 *  - `[a2427723]` (artist ref)        → stripped (resolving to a name would
 *                                       need a rate-limited Discogs call; out
 *                                       of scope; drop the token, don't leave
 *                                       brackets)
 *  - `[l=Jive]` (label ref)           → stripped
 *  - `[m=27117]` (master/release ref) → stripped
 *  - `''` / `''s` (Discogs escapes)   → `'` / `'s`
 *  - bare http(s) URLs on their own line → moved to the Sources list, removed
 *                                          from the bio
 *  - trailing whitespace / empty paragraphs → trimmed
 *
 * The formatter preserves `\n\n` paragraph breaks (Discogs profiles are
 * paragraph-separated; collapsing them would mush long bios into a wall).
 */

// `[url=URL]Label[/url]` — label is kept, URL is dropped (caller doesn't need
// it; if it appeared in the profile, the artist's `urls` field already has it).
const URL_TAG = /\[url=[^\]]+\]([\s\S]*?)\[\/url\]/gi;
// `[a123]`, `[a123456]`, `[a1234567]` — Discogs artist ref (id only).
// Consume a single trailing horizontal space so the natural `[a123] word`
// idiom doesn't leave a double space behind after the bracket is removed.
// Newlines are *not* consumed — paragraph breaks must survive.
const ARTIST_REF = /\[a\d+\][ \t]?/gi;
// `[l=Label]`, `[r123]`, `[m123]` — other Discogs ref tokens
// (label/release/master). The RHS is `[^\]]+`, not `\d+`, because Discogs
// label refs use a name (`[l=Jive]`) while release/master refs are numeric.
const OTHER_REF = /\[[lrm]=[^\]]+\][ \t]?/gi;
// Discogs escapes single quotes as `''` — unescape them. Word-boundary aware
// so we don't touch the possessive `'s` already in plain text.
const ESCAPED_QUOTE = /''/g;

// Match a line that's *only* a URL (or URL + trailing whitespace). Bare URLs
// that are *inline* with prose are left in place — only the "trailing
// paste-a-list-of-links" idiom Discogs profiles tend to end with is extracted.
const BARE_URL_LINE = /^\s*https?:\/\/\S+\s*$/i;

/** Discogs profile → clean text + extracted URL list. */
export function formatArtistBio(raw: string | null | undefined): {
  bio: string | null;
  urls: string[];
} {
  if (!raw) return { bio: null, urls: [] };
  let text = raw;
  // Order matters: strip URL-tags first so the label is preserved before any
  // naked `[a…]` inside it gets pulled.
  text = text.replace(URL_TAG, (_m, label) => label ?? '');
  text = text.replace(ARTIST_REF, '');
  text = text.replace(OTHER_REF, '');
  text = text.replace(ESCAPED_QUOTE, "'");

  // Extract bare-URL lines → urls[]. The remaining prose is what we render.
  const urls: string[] = [];
  const keptLines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (BARE_URL_LINE.test(line)) {
      const u = line.trim();
      // Reject obvious non-URLs (defensive — the regex already requires http(s)).
      if (u) urls.push(u);
    } else {
      keptLines.push(line);
    }
  }
  // Collapse 3+ consecutive blank lines down to 2 (the canonical paragraph
  // separator) so the result reads as a tight article.
  const joined = keptLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    bio: joined ? joined : null,
    urls: dedupeCaseInsensitive(urls),
  };
}

/**
 * Merge multiple URL lists into one deduped, case-insensitive list. Used to
 * combine the formatter's extracted URLs with the API's `urls` field (which
 * may already contain some of them) for the "Sources" disclosure.
 */
export function mergeArtistSources(...lists: ReadonlyArray<readonly string[]>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const raw of list) {
      const u = raw.trim();
      if (!u) continue;
      const key = u.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(u);
    }
  }
  return out;
}

function dedupeCaseInsensitive(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

/**
 * Is the element's content taller than its visible (clamped) area? The
 * show-more toggle is gated on this — a char-count gate (the old
 * `bio.length > 280`) doesn't match the visual clip, so the button would
 * appear with nothing to expand (Britney bug) or stay hidden when it
 * shouldn't (ABBA bug). Pure so it's unit-testable without a layout.
 * The 1px tolerance absorbs sub-pixel rounding from `line-clamp`.
 */
export function isOverflowing(el: Pick<HTMLElement, 'scrollHeight' | 'clientHeight'>): boolean {
  return el.scrollHeight > el.clientHeight + 1;
}
