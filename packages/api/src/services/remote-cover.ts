import { createHash } from 'node:crypto';
import { assertFetchableUrl } from './fetch-guard.js';

/**
 * Proxy for catalog (Lidarr/MusicBrainz) album covers.
 *
 * why: catalog cards used to render Lidarr's `remoteUrl` directly, which is a
 * 1200 px original on a third-party CDN — measured on prod at 878 KB for seven
 * tiles, each drawn into a ~150 px grid square (issue #263). Routing them
 * through our own origin lets the existing `/api/cover` machinery downscale to
 * a sized WebP and cache it on disk, so the second viewer pays nothing and the
 * browser never talks to `images.lidarr.audio` at all.
 *
 * It also fixes the shape Lidarr returns for albums it has cached locally: a
 * *relative* `/MediaCover/Albums/…` path, which the browser resolves against
 * NicotinD's origin and 404s. The server can reach Lidarr, so it resolves that
 * form against the configured Lidarr base URL.
 */

/**
 * Hosts this proxy will fetch from. An open URL proxy is an SSRF hole, so the
 * only absolute URLs allowed are the art CDNs Lidarr/MusicBrainz actually hand
 * us; anything else is rejected before a request is made. The configured Lidarr
 * host is allowed separately (it is operator-supplied, not attacker-supplied).
 */
const ALLOWED_COVER_HOSTS = new Set([
  'images.lidarr.audio',
  'coverartarchive.org',
  'ia800000.us.archive.org',
  'archive.org',
]);

/** Path prefix of Lidarr's own locally-cached media covers. */
const LIDARR_MEDIA_COVER_PREFIX = '/MediaCover/';

/**
 * Pure: reduce a raw Lidarr image value to something that can actually be
 * fetched — an absolute URL, or the `/MediaCover/…` path Lidarr serves.
 *
 * why: Lidarr's `remoteUrl` stops being a URL once it has cached the art
 * locally. It then reports the file's path *inside its own container*
 * (`/config/MediaCover/1819/poster.jpg`), which `fetch()` rejects as invalid.
 * Storing that verbatim is how half of prod's artist portraits (667 of 1,331)
 * became rows that satisfy "this artist has a portrait" while rendering the
 * placeholder forever (#1062). The servable path is a suffix of it, so this
 * recovers it rather than discarding the image.
 */
export function lidarrCoverPath(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  if (/^https?:\/\//i.test(raw)) return raw;
  // Windows-hosted Lidarr reports a backslash path; the marker is the same.
  const i = raw.replace(/\\/g, '/').indexOf(LIDARR_MEDIA_COVER_PREFIX);
  return i === -1 ? undefined : raw.replace(/\\/g, '/').slice(i);
}

/**
 * Pure: turn a **stored** canonical artwork value into an absolute URL the
 * cover route can fetch.
 *
 * Deliberately not `resolveRemoteCoverUrl`: that one guards an *attacker*-
 * supplied `?u=` against SSRF with a host allowlist, and the canonical store
 * legitimately holds provider URLs outside it (discogs, theaudiodb, wikimedia).
 * Applying the allowlist here would blank those covers; this only needs the
 * relative→absolute half.
 */
export function absolutizeLidarrCoverUrl(
  raw: string | undefined | null,
  lidarrBaseUrl?: string | null,
): string | null {
  const value = lidarrCoverPath(raw);
  if (!value) return null;
  if (!value.startsWith(LIDARR_MEDIA_COVER_PREFIX)) return value;
  if (!lidarrBaseUrl) return null;
  try {
    return new URL(value, lidarrBaseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Pure: map a raw Lidarr cover value to a browser-resolvable proxy URL.
 *
 * Returns a relative `/api/cover/remote?...` URL — `CoverArtComponent` runs
 * every src through `ServerConfigService.apiUrl()`, which rewrites a relative
 * `/api/...` to the configured server origin, so this works on web, the native
 * shell and the desktop app alike. Returns undefined for a value we would not
 * be able to fetch, so the card falls back to its placeholder rather than
 * rendering a broken image.
 */
export function proxiedCoverUrl(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  if (!isProxyableCoverUrl(raw)) return undefined;
  return `/api/cover/remote?u=${encodeURIComponent(raw)}`;
}

/** Pure: would `resolveRemoteCoverUrl` accept this value? */
export function isProxyableCoverUrl(raw: string): boolean {
  const value = lidarrCoverPath(raw);
  if (!value) return false;
  if (value.startsWith(LIDARR_MEDIA_COVER_PREFIX)) return true;
  try {
    // Shared SSRF guard: enforces the cover-host allowlist AND rejects
    // private/loopback targets (a no-op for these public art CDNs, but the one
    // implementation both this proxy and addon-provided URLs go through).
    assertFetchableUrl(value, { allowedHosts: ALLOWED_COVER_HOSTS });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pure: turn the `u` query value back into an absolute URL to fetch, or null
 * when it is not one we are willing to request. Relative `/MediaCover/…` paths
 * resolve against the configured Lidarr base URL — the case the browser cannot
 * reach on its own.
 */
export function resolveRemoteCoverUrl(
  raw: string | undefined | null,
  lidarrBaseUrl?: string | null,
): string | null {
  const value = lidarrCoverPath(raw);
  if (!value) return null;

  if (value.startsWith(LIDARR_MEDIA_COVER_PREFIX)) {
    if (!lidarrBaseUrl) return null;
    try {
      return new URL(value, lidarrBaseUrl).toString();
    } catch {
      return null;
    }
  }

  return isProxyableCoverUrl(value) ? value : null;
}

/**
 * Cache key for a proxied cover: content-addressed on the upstream URL, so two
 * albums sharing artwork share one cache entry and a changed upstream URL is a
 * natural miss. `r_` namespaces it away from the library's own cover keys.
 */
export function remoteCoverCacheKey(resolvedUrl: string): string {
  return `r_${createHash('sha1').update(resolvedUrl).digest('hex')}`;
}
