import type { Track } from '../services/player.service';
import type { PlaylistSummary } from '../services/api/api-types';
import type { PreserveService } from '../services/preserve.service';
import type { PlaylistService } from '../services/playlist.service';
import type { AlbumRef, TrackAction } from '../components/track-row/track-row.component';

export interface BaseSong {
  id: string;
  title: string;
  artist: string;
  artistId?: string;
  artists?: Array<{ id: string; name: string; role: 'primary' | 'featuring' }>;
  album?: string;
  albumId?: string;
  coverArt?: string;
  coverRev?: number;
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
    albumId: song.albumId,
    coverArt: song.coverArt,
    coverRev: song.coverRev,
    duration: song.duration,
    bitRate: song.bitRate,
    genre: song.genre,
    bpm: song.bpm,
    key: song.key,
  };
}

/**
 * The `[album]` input for a `TrackRowComponent`: the album name linked to its
 * page when the id is known, a plain name when it is not (offline metadata),
 * `undefined` when the song has no album at all so the row renders nothing.
 */
export function albumRef(song: { album?: string; albumId?: string }): AlbumRef | undefined {
  if (!song.albumId && !song.album) return undefined;
  return { id: song.albumId || undefined, name: song.album ?? '' };
}

/**
 * Build the "Save offline" / "Remove download" toggle action for a track-row menu.
 * The label reflects the live preserve state (saved / in-progress / not saved).
 *
 * This is the one-track lane, and the only one that costs a data-saving
 * listener exactly the track they asked for. `label` stays English because it
 * is the `@for` key and the `data-testid` suffix; `labelKey` is what is
 * rendered.
 */
export function offlineTrackAction(preserve: PreserveService, track: Track): TrackAction {
  const preserved = preserve.isPreserved(track.id);
  const inProgress = preserve.isPreserving(track.id);
  return {
    label: inProgress ? 'Saving…' : preserved ? 'Remove download' : 'Save offline',
    labelKey: inProgress
      ? 'song.savingOffline'
      : preserved
        ? 'song.removeDownload'
        : 'song.saveOffline',
    icon: 'download',
    group: 'keep',
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
    labelKey: 'song.addToPlaylist',
    icon: 'list-music',
    group: 'keep',
    quick: true,
    // The dialog, for a caller that runs the action directly. A menu opens the
    // submenu below instead (#2009).
    action: () => playlists.openPicker([songId]),
    children: async () => {
      if (!playlists.loaded()) await playlists.refresh();
      return playlistSubmenu(playlists.playlists(), {
        add: (playlistId) => void playlists.addSongs(playlistId, [songId]),
        create: (name) => void playlists.create(name, [songId]),
      });
    },
  };
}

/** Playlists past this many get a filter field at the top of the submenu. */
export const PLAYLIST_FILTER_FROM = 8;

/**
 * The rows of "Add to playlist ▸" (#2009): a filter once there are many, a
 * field that creates a playlist from the typed name, then the user's own
 * playlists, most recently changed first. Curated playlists and Liked Songs
 * are left out: neither takes a song this way.
 */
export function playlistSubmenu(
  playlists: readonly PlaylistSummary[],
  ops: { add: (playlistId: string) => void; create: (name: string) => void },
): TrackAction[] {
  const own = playlists
    .filter((p) => p.kind === 'user')
    .sort((a, b) => b.modifiedAt - a.modifiedAt || a.name.localeCompare(b.name));
  const rows: TrackAction[] = [];
  if (own.length > PLAYLIST_FILTER_FROM) {
    rows.push({
      label: 'Find a playlist',
      action: () => {},
      field: { kind: 'filter', placeholderKey: 'song.playlistFind' },
    });
  }
  rows.push({
    label: 'New playlist',
    action: () => {},
    field: { kind: 'submit', placeholderKey: 'song.playlistNewName', submit: ops.create },
  });
  const seen = new Map<string, number>();
  for (const p of own) {
    // Two playlists may share a name; a row's label is also its key and test id.
    const n = (seen.get(p.name) ?? 0) + 1;
    seen.set(p.name, n);
    rows.push({
      label: n === 1 ? p.name : `${p.name} (${n})`,
      icon: 'list-music',
      action: () => ops.add(p.id),
    });
  }
  return rows;
}
