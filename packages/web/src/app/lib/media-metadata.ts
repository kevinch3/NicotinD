// Pure builder for the media-session metadata (title/artist/album + multi-size
// artwork). Kept DI-free so it's unit-testable without Angular or the Capacitor
// plugin. The artwork `src` is produced by the caller's URL builder (which knows
// the configured server + auth token), so this stays free of app services.
// The builder gets the whole `CoverRef`, rev included (#1666): the OS and the
// native plugins cache lock-screen bitmaps by URL, so an id-only URL keeps the
// replaced cover there.

import { songCover, type CoverRef } from './cover-url';

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
  albumId?: string | null;
  coverArt?: string | null;
  coverRev?: number;
}

/** Artwork sizes requested for the lock-screen / notification (px, square). */
export const ARTWORK_SIZES = [96, 256, 512] as const;

export function buildMediaMetadata(
  track: TrackLike,
  coverUrl: (cover: CoverRef, size: number) => string,
): MediaMetadataInit {
  const cover = songCover(track);
  return {
    title: track.title,
    artist: track.artist,
    album: track.album ?? '',
    artwork: cover
      ? ARTWORK_SIZES.map((size) => ({
          src: coverUrl(cover, size),
          sizes: `${size}x${size}`,
          type: 'image/jpeg',
        }))
      : [],
  };
}
