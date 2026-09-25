/**
 * Filesystem-safe path-segment sanitization for music library organization.
 * Library destination layout is `<musicDir>/<Artist>/<Album>/<NN - Title>.<ext>`,
 * or `<D-NN - Title>.<ext>` for a track of a multi-disc release (issue #747).
 */

const ILLEGAL = /[<>:"|?*\x00-\x1f\\/]/g;
const COLLAPSE_WS = /\s+/g;
const TRAILING_DOTS = /\.+$/;

export function sanitizeSegment(raw: string, maxLen = 180): string {
  if (!raw) return '';
  let s = raw.normalize('NFC');
  s = s.replace(ILLEGAL, ' ');
  s = s.replace(COLLAPSE_WS, ' ').trim();
  s = s.replace(TRAILING_DOTS, '').trim();
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  return s;
}

export function isPhantomMatch(parentBasename: string, childBasename: string): boolean {
  return parentBasename === childBasename;
}

const positive = (n: number | undefined): n is number =>
  n !== undefined && Number.isFinite(n) && n > 0;

/**
 * `NN - `, or `D-NN - ` when `disc` is given. The caller passes a disc only for
 * a multi-disc release ({@link isMultiDiscRelease}), so a single-disc album keeps
 * the plain prefix and none of its song ids (path-derived) re-mint.
 */
export function trackNumberPrefix(n: number | undefined, disc?: number): string {
  if (!positive(n)) return '';
  const track = String(Math.floor(n)).padStart(2, '0');
  return positive(disc) ? `${Math.floor(disc)}-${track} - ` : `${track} - `;
}

/**
 * Whether a release spans more than one disc, judged conservatively from tags:
 * some track sits on a disc above 1, or some track's disc total is above 1.
 * `1/1`, a bare `1` and no disc tag at all are all single-disc.
 */
export function isMultiDiscRelease(
  tracks: ReadonlyArray<{ discNumber?: number; discTotal?: number }>,
): boolean {
  return tracks.some(
    (t) =>
      (positive(t.discNumber) && t.discNumber > 1) || (positive(t.discTotal) && t.discTotal > 1),
  );
}

const ORGANIZER_PREFIX = /^\s*(?:(\d{1,2})-)?(\d{1,3})\s+-\s+(\S.*)$/;

/**
 * Parse the organizer's own filename stem (`NN - Title` / `D-NN - Title`) back
 * into its parts. Returns null for any other shape. Disc 1 and no disc are
 * reported as-is; callers that key identity treat them as the same disc.
 */
export function parseOrganizerStem(
  stem: string,
): { disc?: number; track: number; title: string } | null {
  const m = stem.match(ORGANIZER_PREFIX);
  if (!m) return null;
  const out: { disc?: number; track: number; title: string } = {
    track: Number(m[2]),
    title: m[3]!.trim(),
  };
  if (m[1] !== undefined) out.disc = Number(m[1]);
  return out;
}

/**
 * The leading track number a filename groups by — `D-NN` for the organizer's
 * multi-disc shape (so two discs' track 01 stay apart), else the leading digits.
 * Null when the name has no leading number.
 */
export function leadingTrackKey(filename: string): string | null {
  const m = filename.match(/^(\d{1,2}-\d{1,3}(?=\s+-\s)|\d+)/);
  return m ? m[1]! : null;
}

const AUDIO_EXT_SUFFIX = /\.(mp3|flac|ogg|opus|m4a|wav|aac|aiff|alac)$/i;
/** Strip a trailing audio extension. Used when a peer-side dir is named after a file (slskd phantom pattern). */
export function stripAudioExt(s: string): string {
  return s.replace(AUDIO_EXT_SUFFIX, '');
}

const TRACK_NUM_PREFIX = /^\s*\d{1,3}\s*[.)\-_]\s*/;
/**
 * Strip a leading track-number prefix (`"01. "`, `"3) "`, `"04 - "`). Returns
 * the bare value or empty string if nothing remains. Used to detect/clean
 * fragment-shaped artist values like `"01. Sailor & I"`.
 */
export function stripTrackPrefix(s: string): string {
  return s.replace(TRACK_NUM_PREFIX, '').trim();
}

/** True if the string is *just* a track-number fragment (`"01"`, `"03."`, `" 006"`). */
export function isTrackNumberFragment(s: string): boolean {
  return /^\s*\d{1,3}\s*[.)\-_]?\s*$/.test(s);
}

/**
 * Detects album/title tag values that are actually filename leakage:
 * `"01 - Artist - Track.mp3"`, `"03. Song.flac"`, `"04-song.opus"`. These
 * end in an audio extension OR start with a track-number prefix and are
 * never legitimate album names.
 */
export function looksLikeFilenameTag(s: string): boolean {
  if (!s) return false;
  const trimmed = s.trim();
  if (AUDIO_EXT_SUFFIX.test(trimmed)) return true;
  // Starts with track-number prefix AND contains either ` - ` or `.mp3`-style
  // separators that wouldn't appear in a real album name.
  if (TRACK_NUM_PREFIX.test(trimmed)) return true;
  return false;
}

/**
 * Strip leading orphan punctuation from artist values — `"& Peter Tosh"`
 * (truncated `"X & Peter Tosh"`), `", Recondite"`, `"feat. Solomun"`.
 */
const LEADING_JUNK = /^[\s&,;|/+]+|^(feat\.?|featuring|with|vs\.?|x)\s+/i;
export function stripArtistLeadJunk(s: string): string {
  let prev: string;
  let cur = s.trim();
  do {
    prev = cur;
    cur = cur.replace(LEADING_JUNK, '').trim();
  } while (cur !== prev && cur.length > 0);
  return cur;
}

const TRAILING_FEAT_BRACKET = /\s*[([]\s*(feat\.?|ft\.?|featuring|with|w\/)\b[^)\]]*[)\]]\s*$/i;
const TRAILING_FEAT_BARE = /\s+(feat\.?|ft\.?|featuring|with|w\/)\s+\S.*$/i;
const TRAILING_PUNCT = /[\s,;\-&+|/]+$/;

/**
 * Strip a trailing featuring credit so `"Daft Punk feat. Pharrell"` → `"Daft Punk"`.
 * Handles bare suffixes (`feat`, `ft`, `featuring`, `with`, `w/`) and parenthesized
 * or bracketed variants. Leaves `&` / `,` joiners inside the artist value intact
 * (band names like `"Earth, Wind & Fire"` are preserved).
 */
export function stripFeaturingSuffix(s: string): string {
  if (!s) return s;
  let cur = s.replace(TRAILING_FEAT_BRACKET, '');
  cur = cur.replace(TRAILING_FEAT_BARE, '');
  cur = cur.replace(TRAILING_PUNCT, '').trim();
  return cur;
}
