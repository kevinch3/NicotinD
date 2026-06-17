// Pure builder for the media-session metadata (title/artist/album + multi-size
// artwork). Kept DI-free so it's unit-testable without Angular or the Capacitor
// plugin. The artwork `src` is produced by the caller's URL builder (which knows
// the configured server + auth token), so this stays free of app services.

export interface MediaArtwork {
  src: string;
  sizes: string;
  type: string;
}

export interface MediaMetadataInit {
  title: string;
  artist: string;
  album: string;
  artwork: MediaArtwork[];
}

export interface TrackLike {
  title: string;
  artist: string;
  album?: string | null;
  coverArt?: string | null;
}

/** Artwork sizes requested for the lock-screen / notification (px, square). */
export const ARTWORK_SIZES = [96, 256, 512] as const;

export function buildMediaMetadata(
  track: TrackLike,
  coverUrl: (coverArt: string, size: number) => string,
): MediaMetadataInit {
  const coverArt = track.coverArt;
  return {
    title: track.title,
    artist: track.artist,
    album: track.album ?? '',
    artwork: coverArt
      ? ARTWORK_SIZES.map((size) => ({
          src: coverUrl(coverArt, size),
          sizes: `${size}x${size}`,
          type: 'image/jpeg',
        }))
      : [],
  };
}
