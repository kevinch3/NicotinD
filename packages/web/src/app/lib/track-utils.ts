import type { Track } from '../services/player.service';
import type { PreserveService } from '../services/preserve.service';
import type { PlaylistService } from '../services/playlist.service';
import type { TrackAction } from '../components/track-row/track-row.component';

export interface BaseSong {
  id: string;
  title: string;
  artist: string;
  artistId?: string;
  artists?: Array<{ id: string; name: string; role: 'primary' | 'featuring' }>;
  album?: string;
  coverArt?: string;
  duration?: number;
  bitRate?: number;
  genre?: string;
  bpm?: number;
  key?: string;
}

export function toTrack(song: BaseSong, fallbackAlbum?: string): Track {
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    artistId: song.artistId,
    artists: song.artists,
    album: song.album ?? fallbackAlbum,
    coverArt: song.coverArt,
    duration: song.duration,
    bitRate: song.bitRate,
    genre: song.genre,
    bpm: song.bpm,
    key: song.key,
  };
}

/**
 * Build the "Save offline" / "Remove download" toggle action for a track-row menu.
 * The label reflects the live preserve state (saved / in-progress / not saved).
 */
export function offlineTrackAction(preserve: PreserveService, track: Track): TrackAction {
  const preserved = preserve.isPreserved(track.id);
  const inProgress = preserve.isPreserving(track.id);
  return {
    label: inProgress ? 'Saving…' : preserved ? 'Remove download' : 'Save offline',
    destructive: preserved,
    action: () => {
      if (inProgress) return;
      if (preserved) void preserve.remove(track.id);
      else void preserve.preserve(track);
    },
  };
}

/**
 * Build the "Add to playlist" action for a track-row menu — opens the global
 * picker (mounted in the layout) for a single song. Shared so every track list
 * (album, search, genre, playlist) surfaces the same affordance.
 */
export function addToPlaylistAction(playlists: PlaylistService, songId: string): TrackAction {
  return {
    label: 'Add to playlist',
    action: () => playlists.openPicker([songId]),
  };
}
