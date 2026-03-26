import type { Track } from '@/stores/player';

export interface BaseSong {
  id: string;
  title: string;
  artist: string;
  album?: string;
  coverArt?: string;
  duration?: number;
}

/**
 * Converts a song object (from search, library, or playlists) to a standard Player Track.
 */
export function toTrack(song: BaseSong, fallbackAlbum?: string): Track {
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    album: song.album ?? fallbackAlbum,
    coverArt: song.coverArt,
    duration: song.duration,
  };
}
