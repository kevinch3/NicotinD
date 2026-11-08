/**
 * Pure mappers from the API's album/playlist responses to the share-view's
 * display model. Kept DI-free so they're unit-testable without rendering the
 * component (the JIT vitest harness can't drive signals/HttpClient).
 *
 * The playlist API returns `songs` (not `entry`) and has no `owner` field —
 * getting those names wrong is exactly the bug that made shared playlists render
 * empty, so these mappers are the single source of truth for the shape.
 */

import { albumCover, artistCover, songCover, type CoverRef } from '../../lib/cover-url';

export interface ShareTrack {
  id: string;
  title: string;
  artist: string;
  duration?: number;
  coverArt?: string;
  /** The album's `cover_rev` and its owner, so the cover URL carries it (#1666). */
  coverRev?: number;
  albumId?: string;
  track?: number;
}

export interface ShareResourceView {
  name: string;
  subtitle: string;
  /** The cover, rev included (#1666), or null when there's no art. */
  cover: CoverRef | null;
  /**
   * A ready image URL shown in place of `cover` — a curated playlist's designed
   * cover (`/playlist-covers/<slug>.svg`), which is a URL, not a cover id.
   */
  coverImage?: string;
  tracks: ShareTrack[];
  ogDescription: string;
  ogType: 'music.album' | 'music.playlist' | 'profile';
  /** Artist bio excerpt, shown above the track list on an artist share. */
  bio?: string;
}

function toTracks(raw: any[]): ShareTrack[] {
  return (raw ?? []).map((s: any) => ({
    id: s.id,
    title: s.title,
    artist: s.artist,
    duration: s.duration,
    coverArt: s.coverArt,
    coverRev: s.coverRev,
    albumId: s.albumId,
    track: s.track,
  }));
}

export function mapSharedAlbum(album: any): ShareResourceView {
  const tracks = toTracks(album.song);
  return {
    name: album.name,
    subtitle: album.artist,
    cover: albumCover(album),
    tracks,
    ogDescription: album.artist,
    ogType: 'music.album',
  };
}

/**
 * Artist share view (issue #229): portrait + name + bio + a playable list of the
 * artist's songs (mirroring album/playlist shares so the guest's 5-minute window
 * is a real preview, not a dead card). `artist` is the `GET /artists/:id`
 * `{ artist }` object; `songs` the `GET /artists/:id/songs` page.
 */
export function mapSharedArtist(artist: any, songs: any[]): ShareResourceView {
  const tracks = toTracks(songs);
  const count = artist?.albumCount ?? 0;
  const subtitle = `${count} ${count === 1 ? 'album' : 'albums'}`;
  const bio = typeof artist?.bio === 'string' && artist.bio.trim() ? artist.bio.trim() : undefined;
  return {
    name: artist?.name ?? 'Artist',
    subtitle,
    // Cover route is keyed on the artist id (audio files carry no artist photo).
    cover: artistCover({
      id: artist?.id ?? artist?.coverArt ?? '',
      coverArt: artist?.id ?? artist?.coverArt,
      coverRev: artist?.coverRev,
    }),
    tracks,
    ogDescription: bio ?? subtitle,
    ogType: 'profile',
    bio,
  };
}

export function mapSharedPlaylist(pl: any): ShareResourceView {
  const tracks = toTracks(pl.songs);
  // A playlist's `coverArt` is a designed-cover URL (curated) or null, never a
  // cover id: the URL is shown as is, and `cover` is the first track's art, so
  // og:image stays a raster the server's own og:image also uses.
  const coverImage = isImageUrl(pl.coverArt) ? pl.coverArt : undefined;
  const cover =
    pl.coverArt && !coverImage ? songCover({ coverArt: pl.coverArt }) : songCover(tracks[0] ?? {});
  const trackLabel = `${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'}`;
  return {
    name: pl.name,
    subtitle: trackLabel,
    cover,
    ...(coverImage ? { coverImage } : {}),
    tracks,
    ogDescription: trackLabel,
    ogType: 'music.playlist',
  };
}

const isImageUrl = (v: unknown): v is string =>
  typeof v === 'string' && (v.startsWith('/') || /^https?:\/\//.test(v));
