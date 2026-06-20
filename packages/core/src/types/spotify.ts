/**
 * A single Spotify album returned by the metadata fallback lane
 * (`GET /api/spotify/search`). Spotify exposes **metadata only** — no audio — so
 * `url` (the canonical `https://open.spotify.com/album/<id>`) is handed to
 * `POST /api/acquire`, where the **spotDL** resolve plugin downloads it. This is
 * the Spotify analogue of `ArchiveCandidate.detailsUrl`.
 */
export interface SpotifyCandidate {
  /** Spotify album id. */
  id: string;
  /** Canonical open.spotify.com album URL — the value passed to /api/acquire. */
  url: string;
  title: string;
  artist: string;
  /** Release year (from `release_date`), or null when absent. */
  year: string | null;
  /** Album cover (largest image), when present. */
  coverUrl?: string;
  /** Number of tracks on the album (Spotify `total_tracks`). */
  trackCount?: number | null;
  /** `single` (1 track) or `album` (2+); null when the track count is unknown. */
  kind?: 'single' | 'album' | null;
}
