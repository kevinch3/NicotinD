/**
 * How a Downloads-feed card is named (docs/download-pipeline.md "Card titles").
 *
 * Every acquisition backend lands in one feed, so one deterministic, pure
 * fallback chain decides what a row is *called* — rather than each lane
 * inventing its own label. The chain exists because the old answer for a URL
 * acquire was the literal string `"<Source> download"`, which duplicates the
 * method chip rendered immediately to its left and tells the user nothing:
 * three simultaneous YouTube links were three rows all reading
 * "YouTube download".
 *
 * The rungs are ordered by *quality*, not by recency, so a card's title only
 * ever improves as a job progresses (addon metadata arrives, then files land)
 * instead of flapping between equally-good sources. In order: the addon's
 * display title, the canonical album, the albums the files landed in, the
 * source/peer folder, a bare artist name, the pasted link, and only then the
 * source label.
 */
import type { AcquireAlbumDestination } from '../types/acquire.js';
import { classifyAcquireUrl, type AcquireUrlKind } from '../types/classify-acquire-url.js';
import { cleanFolderName, isGenericFolderName } from './folder-name.js';

export interface DownloadTitleInput {
  /**
   * The addon's own display name for the job — a playlist name, a video
   * title, a release name. Display-only and deliberately NOT `albumTitle`:
   * that one is *filing* metadata (it mints an album id and tells the
   * organizer where the files go), so a playlist name there would create a
   * phantom album and mis-file every track in it.
   */
  displayTitle?: string | null;
  albumTitle?: string | null;
  artistName?: string | null;
  /** Where the files actually landed — observed truth, once the scan lands. */
  destinationAlbums?: AcquireAlbumDestination[];
  /** Enqueued files; their common directory is the peer/source folder name. */
  items?: { filename?: string | null }[];
  /** The link the user pasted, for URL acquires. */
  sourceUrl?: string | null;
}

/**
 * `source` is returned **structured** rather than as a baked English string so
 * the caller renders it from its own method label (and can localize it) — the
 * previous hard-coded `"${label} download"` could do neither.
 */
export type DownloadTitle =
  { kind: 'text'; text: string; subtitle?: string } | { kind: 'source'; urlKind?: AcquireUrlKind };

const nonEmpty = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim();
  return t.length > 0 ? t : null;
};

/** Directory portion of a peer path (slskd sends Windows-style backslashes). */
function dirOf(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx > 0 ? normalized.slice(0, idx) : '';
}

/**
 * Turn a URL slug into prose: `rodopiado-veneno-feat-sophia-ardessore` →
 * `Rodopiado Veneno Feat Sophia Ardessore`. Only the first letter of each word
 * is touched, so an acronym or a roman numeral ("Pt. II") survives intact.
 */
export function humanizeSlug(slug: string): string {
  let text = slug;
  try {
    text = decodeURIComponent(slug);
  } catch {
    // A malformed escape is not worth failing a title over.
  }
  return text
    .replace(/[-_+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(' ');
}

/**
 * Does this path segment look like something a human wrote, rather than an id
 * or a routing word? Guessing wrong is worse than not guessing: "37i9dQZ…"
 * as a title is strictly less useful than "Spotify playlist".
 */
export function isHumanSlug(segment: string): boolean {
  const s = segment.trim();
  // ≤2 chars covers locale prefixes (`/es/`, `/en/`) and route letters (`/v/`).
  if (s.length <= 2) return false;
  if (!/[a-z]/i.test(s)) return false; // pure digits / punctuation
  if (STRUCTURAL_SEGMENTS.has(s.toLowerCase())) return false;
  const hasSeparator = /[-_+\s]/.test(s);
  // A separator-less mixed-case-with-digits blob is an opaque id (a YouTube
  // video id, a Spotify base62 id) — never a title someone typed.
  if (!hasSeparator && s.length >= 8 && /\d/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s)) {
    return false;
  }
  return true;
}

/** Path words that describe the *route*, never the thing at the end of it. */
const STRUCTURAL_SEGMENTS = new Set([
  'release',
  'releases',
  'album',
  'albums',
  'track',
  'tracks',
  'song',
  'songs',
  'artist',
  'artists',
  'label',
  'playlist',
  'playlists',
  'video',
  'videos',
  'watch',
  'embed',
  'details',
  'item',
  'items',
  'download',
  'downloads',
  'music',
  'audio',
  'stream',
  'listen',
  'set',
  'sets',
  'index',
  'home',
]);

/**
 * Best title derivable from the pasted link alone. Spotify and YouTube name
 * their content only by opaque id, so those deliberately decline to a
 * structured source label ("Spotify playlist") rather than humanizing an id.
 */
export function titleFromAcquireUrl(rawUrl: string): DownloadTitle | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const { source, kind } = classifyAcquireUrl(rawUrl);
  if (source === 'spotify' || source === 'youtube') {
    return { kind: 'source', urlKind: kind === 'unknown' ? undefined : kind };
  }

  // Everything else (beatport, bandcamp, a blog, archive.org) tends to carry a
  // human slug somewhere in the path — take the deepest one that reads like a
  // name, so `/es/release/<slug>/7142216` skips the trailing numeric id.
  const segments = url.pathname.split('/').filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i]!;
    if (!isHumanSlug(segment)) continue;
    const text = humanizeSlug(segment.replace(/\.[a-z0-9]{2,4}$/i, ''));
    if (!text) continue;
    return { kind: 'text', text, subtitle: url.hostname.replace(/^www\./, '') };
  }
  return null;
}

/**
 * The chain. First rung that yields something wins; the caller renders a
 * `{ kind: 'source' }` result from its own method label.
 *
 * `sourceRef` and the job id are deliberately never rungs — they are internal
 * (`addon:<id>:<uuid>`, an absolute server path) and leaking them as a title is
 * what this function replaces.
 */
export function downloadTitleFor(job: DownloadTitleInput): DownloadTitle {
  const artist = nonEmpty(job.artistName) ?? undefined;

  const display = nonEmpty(job.displayTitle);
  if (display) return { kind: 'text', text: display, subtitle: artist };

  const album = nonEmpty(job.albumTitle);
  if (album) return { kind: 'text', text: album, subtitle: artist };

  const destinations = job.destinationAlbums ?? [];
  if (destinations.length === 1) {
    const only = destinations[0]!;
    return { kind: 'text', text: only.albumTitle, subtitle: only.albumArtist || artist };
  }
  if (destinations.length > 1) {
    return {
      kind: 'text',
      text: `${destinations[0]!.albumTitle} +${destinations.length - 1} more`,
      subtitle: artist,
    };
  }

  // Ahead of a bare artist name on purpose: "Bowie - Heathen (2002)" is how the
  // uploader described the release, and it is strictly more informative than
  // "Bowie". Generic containers were already filtered out above.
  const folder = commonSourceFolder(job.items ?? []);
  if (folder) return { kind: 'text', text: folder, subtitle: artist };

  if (artist) return { kind: 'text', text: artist };

  const fromUrl = job.sourceUrl ? titleFromAcquireUrl(job.sourceUrl) : null;
  if (fromUrl) return fromUrl;

  return { kind: 'source' };
}

/**
 * The folder the job's files came from — for a Soulseek grab that is the peer's
 * own directory name ("Los Tekis - (1995) Toque [FLAC]"), which is exactly how
 * the uploader described the release and far better than nothing. The mode, not
 * the first item, so one stray file from another folder can't name the card;
 * generic containers ("music", "downloads", "CD1") are skipped rather than shown.
 */
function commonSourceFolder(items: { filename?: string | null }[]): string | null {
  const counts = new Map<string, number>();
  for (const item of items) {
    const dir = dirOf(item.filename ?? '');
    if (!dir) continue;
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [dir, count] of counts) {
    if (count > bestCount) {
      best = dir;
      bestCount = count;
    }
  }
  if (!best) return null;
  const cleaned = cleanFolderName(best);
  return cleaned && !isGenericFolderName(cleaned) ? cleaned : null;
}
