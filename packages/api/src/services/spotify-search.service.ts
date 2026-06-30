import { createLogger, ServiceUnavailableError, type SpotifyCandidate } from '@nicotind/core';

const log = createLogger('spotify-search');

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';
const DEFAULT_LIMIT = 20;
// Spotify occasionally 5xxs / rate-limits; one immediate retry recovers a
// transient blip so it doesn't masquerade as "no results".
const MAX_RETRIES = 1;
// Refresh the cached token this many seconds before it actually expires, to
// avoid a request racing the expiry boundary.
const TOKEN_SKEW_SECONDS = 30;

export interface SpotifyCredentials {
  clientId: string;
  clientSecret: string;
}

/** Accessor so the service always reads the admin's *current* configured creds. */
export type SpotifyCredentialsAccessor = () => SpotifyCredentials;

// ── Spotify Web API response shapes (only the fields we read) ──────────────────
interface SpotifyImage {
  url: string;
  height?: number | null;
  width?: number | null;
}
interface SpotifyArtistRef {
  name: string;
}
interface SpotifyAlbumItem {
  id: string;
  name: string;
  album_type?: string;
  total_tracks?: number;
  release_date?: string;
  images?: SpotifyImage[];
  artists?: SpotifyArtistRef[];
  external_urls?: { spotify?: string };
}
interface SpotifySearchResponse {
  albums?: { items?: SpotifyAlbumItem[] };
}
interface SpotifyArtistItem {
  id: string;
  name: string;
  images?: SpotifyImage[];
}
interface SpotifyArtistSearchResponse {
  artists?: { items?: SpotifyArtistItem[] };
}
interface SpotifyTokenResponse {
  access_token: string;
  expires_in: number;
}

/** `single` for a 1-track release, else `album`; null when the count is unknown. */
export function kindFromTrackCount(count: number | null | undefined): 'single' | 'album' | null {
  if (count == null) return null;
  return count <= 1 ? 'single' : 'album';
}

/** First 4-digit year of a Spotify `release_date` (`2012`, `2012-05`, `2012-05-01`). */
export function releaseYear(releaseDate: string | undefined): string | null {
  if (!releaseDate) return null;
  const m = /^(\d{4})/.exec(releaseDate);
  return m ? m[1]! : null;
}

/**
 * Build the `q` for a targeted album lookup using Spotify's field filters. Both
 * pieces are optional — a bare artist or album still produces a usable query.
 */
export function buildAlbumQuery(artist: string, album: string): string {
  const parts: string[] = [];
  if (album.trim()) parts.push(`album:${album.trim()}`);
  if (artist.trim()) parts.push(`artist:${artist.trim()}`);
  return parts.join(' ');
}

/** Map one Spotify album item to a candidate. Pure. */
export function mapSpotifyAlbum(item: SpotifyAlbumItem): SpotifyCandidate {
  const trackCount = item.total_tracks ?? null;
  // Spotify returns images widest-first; the first is the largest.
  const coverUrl = item.images?.[0]?.url;
  const declared = item.album_type;
  return {
    id: item.id,
    url: item.external_urls?.spotify ?? `https://open.spotify.com/album/${item.id}`,
    title: item.name,
    artist: item.artists?.[0]?.name ?? '',
    year: releaseYear(item.release_date),
    coverUrl,
    trackCount,
    kind:
      declared === 'single'
        ? 'single'
        : declared === 'album'
          ? 'album'
          : kindFromTrackCount(trackCount),
  };
}

/**
 * Largest image url for a Spotify artist item, or null. Spotify returns an
 * artist's images widest-first, so the first entry is the highest resolution —
 * ideal for an artist portrait tile. Pure.
 */
export function pickSpotifyArtistImage(item: SpotifyArtistItem | undefined): string | null {
  return item?.images?.[0]?.url ?? null;
}

/** Diacritic-folded `artist + title` token set, for collapsing duplicate releases. */
export function spotifyDedupeKey(c: { artist: string; title: string }): string {
  const raw = `${c.artist} ${c.title}`
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return [...new Set(raw.split(' ').filter(Boolean))].sort().join(' ');
}

/** Map a raw search response → deduped candidate list. Pure. */
export function mapSearchResponse(body: SpotifySearchResponse): SpotifyCandidate[] {
  const items = body.albums?.items ?? [];
  const seen = new Set<string>();
  const out: SpotifyCandidate[] = [];
  for (const item of items) {
    if (!item?.id) continue;
    const candidate = mapSpotifyAlbum(item);
    const key = spotifyDedupeKey(candidate);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(candidate);
  }
  return out;
}

/**
 * Read-only metadata lane over the Spotify Web API. Turns a free-text query
 * (unified search) or an artist+album pair (hunt modal) into album candidates.
 * It never downloads — the client hands a candidate's `url` to `/api/acquire`,
 * which the **spotDL** resolve plugin downloads (Spotify gives metadata only).
 *
 * Auth is the OAuth **client-credentials** flow (app token, no user context),
 * cached in memory until it expires. Credentials are read live from the registry
 * via the injected accessor, so an admin's config edit takes effect immediately.
 */
export class SpotifySearchService {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly credentials: SpotifyCredentialsAccessor,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** Free-text album search (main unified-search page). */
  async search(query: string, limit = DEFAULT_LIMIT): Promise<SpotifyCandidate[]> {
    const q = query.trim();
    if (!q) return [];
    return this.run(q, limit);
  }

  /** Targeted artist + album search (album-hunt modal). */
  async searchAlbum(
    artist: string,
    album: string,
    limit = DEFAULT_LIMIT,
  ): Promise<SpotifyCandidate[]> {
    const q = buildAlbumQuery(artist, album);
    if (!q) return [];
    return this.run(q, limit);
  }

  /**
   * Best-effort artist portrait url for a name, or null. Used as the enrichment
   * fallback when Lidarr has no poster, so — unlike {@link search} — it never
   * throws: missing creds or an upstream blip just yields null and the artist
   * keeps the neutral placeholder rather than surfacing an error.
   */
  async searchArtistImage(name: string): Promise<string | null> {
    const q = name.trim();
    if (!q) return null;
    try {
      const token = await this.accessToken();
      const params = new URLSearchParams({ q, type: 'artist', limit: '1' });
      const url = `${API_BASE}/search?${params.toString()}`;
      const res = await this.fetchWithRetry(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as SpotifyArtistSearchResponse;
      return pickSpotifyArtistImage(body.artists?.items?.[0]);
    } catch (err) {
      log.debug({ err, name }, 'Spotify artist-image lookup failed');
      return null;
    }
  }

  private async run(q: string, limit: number): Promise<SpotifyCandidate[]> {
    const token = await this.accessToken();
    const params = new URLSearchParams({ q, type: 'album', limit: String(limit) });
    const url = `${API_BASE}/search?${params.toString()}`;
    const res = await this.fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = (await res.json()) as SpotifySearchResponse;
    return mapSearchResponse(body);
  }

  /** A valid app token, fetching a fresh one when the cache is empty/expired. */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now()) return this.token.value;

    const { clientId, clientSecret } = this.credentials();
    if (!clientId || !clientSecret) {
      log.warn('Spotify search requested but credentials are not configured');
      throw new ServiceUnavailableError('Spotify (credentials not configured)');
    }

    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await this.fetchWithRetry(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const body = (await res.json()) as SpotifyTokenResponse;
    this.token = {
      value: body.access_token,
      expiresAt: this.now() + (body.expires_in - TOKEN_SKEW_SECONDS) * 1000,
    };
    return this.token.value;
  }

  /**
   * Fetch with one retry. Throws `ServiceUnavailableError` on an unreachable or
   * non-OK upstream so the route surfaces "Spotify unavailable" rather than the
   * misleading empty result an aborted request would imply.
   */
  private async fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await this.fetchFn(url, init);
        if (res.ok) return res;
        lastErr = new Error(`Spotify returned HTTP ${res.status}`);
        // A 401 likely means a stale cached token — drop it so the retry re-auths.
        if (res.status === 401) this.token = null;
      } catch (err) {
        lastErr = err;
      }
    }
    log.warn({ err: lastErr }, 'Spotify request failed after retry');
    throw new ServiceUnavailableError('Spotify');
  }
}
