/**
 * URL classifier for the URL-acquire flow. A single pure function that decides
 * whether a pasted URL points at a *playlist* (so AcquireWatcher should also
 * generate a native per-user playlist from the landed tracks) or at a regular
 * album/track. See docs/playlist-from-acquisition.md.
 *
 * The classifier is intentionally URL-pattern based (not plugin-specific) so
 * the route and the web can both use it without importing a plugin module.
 * Spotify and YouTube distinguish playlist from album/track at the URL level;
 * archive.org items are by-creator/multi-track by default and don't expose a
 * playlist signal, so the caller can override via the `as` arg on
 * `AcquireWatcher.submit`.
 */
export type AcquireUrlKind = 'playlist' | 'album' | 'track' | 'unknown';

export interface ClassifyAcquireUrlResult {
  /** Source host family (drives the web chip + the offline override label). */
  source: 'spotify' | 'youtube' | 'archive' | 'other';
  /** What the URL represents. */
  kind: AcquireUrlKind;
}

/**
 * Lowercase pathname split on `/`, with leading/trailing empties removed.
 * Exported for testability + so callers can re-derive the same components.
 */
export function urlPathSegments(input: string): string[] {
  try {
    const u = new URL(input);
    return u.pathname.split('/').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Spotify's own share sheet emits locale-prefixed links —
 * `open.spotify.com/intl-es/album/<id>` — so the type is the *second* segment,
 * not the first. Reading `segments[0]` classified every one of them as
 * `unknown`: in prod all five album acquires were `intl-es` links, which is
 * half of why one album became twelve (issue #997). The latent half is worse
 * than the reported one — an `intl-*` playlist link would silently skip
 * playlist generation, because that decision is keyed on this same `kind`.
 *
 * Matched narrowly (`intl-` plus a language subtag) so a real first segment is
 * never mistaken for a prefix.
 */
function stripSpotifyLocale(segments: string[]): string[] {
  const first = segments[0]?.toLowerCase() ?? '';
  return /^intl-[a-z]{2}(-[a-z0-9]+)?$/.test(first) ? segments.slice(1) : segments;
}

/**
 * The Spotify resource a link points at, or null when it is not a Spotify link
 * or names no single resource. The id is the path's **last** segment, which is
 * true with or without a locale prefix and with a `?si=` share token attached.
 *
 * Exists so the acquisition lane can ask Spotify what a pasted link *is* before
 * the download starts, instead of learning the name and track count from the
 * transfer itself (issue #989).
 */
export function spotifyResourceFromUrl(
  input: string,
): { kind: 'album' | 'playlist' | 'track'; id: string } | null {
  const { source, kind } = classifyAcquireUrl(input);
  if (source !== 'spotify') return null;
  if (kind !== 'album' && kind !== 'playlist' && kind !== 'track') return null;
  const segments = urlPathSegments(input);
  const id = segments[segments.length - 1];
  return id ? { kind, id } : null;
}

/**
 * Classify an acquire URL by its host + path. Returns `kind: 'unknown'` for
 * anything we don't recognise (slskd-style, custom share links, …) so the
 * caller can treat it as a single-item acquire and skip playlist generation.
 */
export function classifyAcquireUrl(input: string): ClassifyAcquireUrlResult {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { source: 'other', kind: 'unknown' };
  }
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);

  // Spotify: open.spotify.com/<type>/<id>. The host check normalizes both the
  // canonical host and any other (rare) "spotify.com" domain.
  if (host === 'open.spotify.com' || host === 'spotify.com' || host === 'www.spotify.com') {
    const type = stripSpotifyLocale(segments)[0]?.toLowerCase();
    if (type === 'playlist') return { source: 'spotify', kind: 'playlist' };
    if (type === 'album') return { source: 'spotify', kind: 'album' };
    if (type === 'track') return { source: 'spotify', kind: 'track' };
    return { source: 'spotify', kind: 'unknown' };
  }

  // YouTube: playlists are /playlist and watch URLs with a `list=` param.
  // Single-watch URLs without a list are tracks; bare `/watch` without id is unknown.
  if (
    host === 'youtube.com' ||
    host === 'www.youtube.com' ||
    host === 'm.youtube.com' ||
    host === 'music.youtube.com'
  ) {
    const type = segments[0]?.toLowerCase();
    if (type === 'playlist') return { source: 'youtube', kind: 'playlist' };
    if (type === 'watch') {
      const hasList = url.searchParams.has('list');
      return { source: 'youtube', kind: hasList ? 'playlist' : 'track' };
    }
    return { source: 'youtube', kind: 'unknown' };
  }
  if (host === 'youtu.be') {
    // youtu.be/<id> — single video. No playlist signal available.
    return { source: 'youtube', kind: 'track' };
  }

  // archive.org items don't expose a playlist signal at the URL level; the
  // caller can override via `as: 'playlist'` on submit (link-intent card UI).
  if (host === 'archive.org' || host.endsWith('.archive.org')) {
    return { source: 'archive', kind: 'album' };
  }

  return { source: 'other', kind: 'unknown' };
}
