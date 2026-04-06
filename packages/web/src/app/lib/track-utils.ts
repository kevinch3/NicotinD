import type { Track } from '../services/player.service';

export interface BaseSong {
  id: string;
  title: string;
  artist: string;
  artistId?: string;
  album?: string;
  coverArt?: string;
  duration?: number;
}

export function toTrack(song: BaseSong, fallbackAlbum?: string): Track {
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    artistId: song.artistId,
    album: song.album ?? fallbackAlbum,
    coverArt: song.coverArt,
    duration: song.duration,
  };
}
