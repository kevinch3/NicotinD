/**
 * Filesystem-safe path-segment sanitization for music library organization.
 * Library destination layout is `<musicDir>/<Artist>/<Album>/<NN - Title>.<ext>`.
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

export function trackNumberPrefix(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n) || n <= 0) return '';
  return `${String(Math.floor(n)).padStart(2, '0')} - `;
}

const AUDIO_EXT_SUFFIX = /\.(mp3|flac|ogg|opus|m4a|wav|aac|aiff|alac)$/i;
/** Strip a trailing audio extension. Used when a peer-side dir is named after a file (slskd phantom pattern). */
export function stripAudioExt(s: string): string {
  return s.replace(AUDIO_EXT_SUFFIX, '');
}

const TRACK_NUM_PREFIX = /^\s*\d{1,3}\s*[.)\-_]\s+/;
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
