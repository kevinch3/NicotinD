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
 * What the formatter strips / extracts (the ref forms below are BOTH what the
 * Discogs API actually returns — the original #213 version only handled the
 * `=name` shape, so `[a=Name]` member lists and `[b]`/`[i]` tags leaked through
 * as literal garbage):
 *  - `[url=https://…]Label[/url]` / `[url]…[/url]` → the inner text (label kept)
 *  - `[a=Ricardo Mollo]`, `[l=Jive]` (named ref) → the embedded name is KEPT
 *                                       (no Discogs call needed — the name is
 *                                       right there; `[a=Name] - Guitar` reads
 *                                       as `Name - Guitar`)
 *  - `[a1006851]`, `[l12345]`, `[m27117]`, `[r90]` (numeric id ref) → stripped
 *                                       (no display name to show); stray spaces
 *                                       left before punctuation are cleaned up
 *  - `[b]`/`[i]`/`[u]` (+ closers)    → tag dropped, inner text kept
 *  - `''` / `''s` (Discogs escapes)   → `'` / `'s`
 *  - bare http(s) URLs on their own line → moved to the Sources list, removed
 *                                          from the bio
 *  - trailing whitespace / empty paragraphs → trimmed
 *
 * The formatter preserves `\n\n` paragraph breaks (Discogs profiles are
 * paragraph-separated; collapsing them would mush long bios into a wall).
 */

// `[url=URL]Label[/url]` or the label-less `[url]URL[/url]` — the inner text
// is kept, the wrapper dropped (if a real URL appeared, the artist's `urls`
// field already has it, and bare URLs get extracted into Sources below).
const URL_TAG = /\[url(?:=[^\]]+)?\]([\s\S]*?)\[\/url\]/gi;
// Discogs entity refs come in TWO shapes (the API returns both — the original
// #213 fixtures only covered the `=name` form, so the far-more-common shapes
// leaked through as literal `[a=…]`/`[l123]` garbage):
//   named   `[a=Ricardo Mollo]`, `[l=Jive]`  → KEEP the embedded name
//   numeric `[a1006851]`, `[l12345]`, `[m27117]`, `[r90]` → DROP (no name to show)
// `a`=artist `l`=label `m`=master `r`=release. A `[x=12345]` with a purely
// numeric RHS is an id ref written in the `=` form → dropped like the numeric shape.
const NAMED_REF = /\[[almr]=([^\]]+)\]/gi;
const NUMERIC_REF = /\[[almr]\d+\]/gi;
// Inline formatting tags `[b]`/`[i]`/`[u]` (+ closers) — drop the tag, keep the
// inner text (Discogs uses these to head member lists, e.g. `[b]Members:[/b]`).
const FORMAT_TAG = /\[\/?[biu]\]/gi;
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
  // naked ref inside it gets pulled.
  text = text.replace(URL_TAG, (_m, label) => label ?? '');
  // Named refs first (keep the name unless it's a bare id), then numeric refs.
  text = text.replace(NAMED_REF, (_m, name: string) => (/^\d+$/.test(name.trim()) ? '' : name));
  text = text.replace(NUMERIC_REF, '');
  text = text.replace(FORMAT_TAG, '');
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
  // Clean up whitespace artifacts left by dropped refs (`lyricist [a1006851],`
  // → `lyricist ,` → `lyricist,`; `label [l12345] and` → `label  and` → `label and`),
  // then collapse 3+ blank lines to the canonical 2-line paragraph break.
  const joined = keptLines
    .join('\n')
    .replace(/[ \t]+([,.;:!?])/g, '$1') // no space before punctuation
    .replace(/[ \t]{2,}/g, ' ') // collapse runs of spaces/tabs (not newlines)
    .replace(/[ \t]+$/gm, '') // trim trailing spaces per line
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
