// Pure mapping from the web Media Session metadata to the shape the native iOS
// `NicotindNowPlaying` plugin expects. The plugin loads a single artwork image
// itself (it can't iterate a sizes array like the Web API), so we pick the
// largest declared size — the lock screen renders large and downsizes cleanly.
// Kept DI-free so it's unit-testable without Angular or Capacitor.

import type { MediaArtwork, MediaMetadataInit } from './media-metadata';

export interface NativeNowPlayingMetadata {
  title: string;
  artist: string;
  album: string;
  /** Absent when the track has no cover art. */
  artworkUrl?: string;
}

/** The src of the largest-declared-size artwork entry, or undefined if none. */
export function pickArtworkUrl(artwork: MediaArtwork[]): string | undefined {
  let best: MediaArtwork | undefined;
  let bestPx = -1;
  for (const a of artwork) {
    const px = Number.parseInt(a.sizes.split('x')[0] ?? '', 10) || 0;
    if (px > bestPx) {
      bestPx = px;
      best = a;
    }
  }
  return best?.src;
}

export function toNativeMetadata(meta: MediaMetadataInit): NativeNowPlayingMetadata {
  return {
    title: meta.title,
    artist: meta.artist,
    album: meta.album,
    artworkUrl: pickArtworkUrl(meta.artwork),
  };
}
