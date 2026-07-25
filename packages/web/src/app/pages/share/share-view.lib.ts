/**
 * Pure mappers from the API's album/playlist responses to the share-view's
 * display model. Kept DI-free so they're unit-testable without rendering the
 * component (the JIT vitest harness can't drive signals/HttpClient).
 *
 * The playlist API returns `songs` (not `entry`) and has no `owner` field —
 * getting those names wrong is exactly the bug that made shared playlists render
 * empty, so these mappers are the single source of truth for the shape.
 */

export interface ShareTrack {
  id: string;
  title: string;
  artist: string;
  duration?: number;
  coverArt?: string;
  track?: number;
}

export interface ShareResourceView {
  name: string;
  subtitle: string;
  /** Cover id for `/api/cover/<id>`, or null when there's no art. */
  coverId: string | null;
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
    track: s.track,
  }));
}

export function mapSharedAlbum(album: any): ShareResourceView {
  const tracks = toTracks(album.song);
  return {
    name: album.name,
    subtitle: album.artist,
    coverId: album.coverArt ?? null,
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
    coverId: artist?.id ?? artist?.coverArt ?? null,
    tracks,
    ogDescription: bio ?? subtitle,
    ogType: 'profile',
    bio,
  };
}

export function mapSharedPlaylist(pl: any): ShareResourceView {
  const tracks = toTracks(pl.songs);
  // A user playlist has no canonical cover id; fall back to the first track's
  // art so the share still gets a thumbnail.
  const coverId = pl.coverArt ?? tracks[0]?.coverArt ?? null;
  const trackLabel = `${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'}`;
  return {
    name: pl.name,
    subtitle: trackLabel,
    coverId,
    tracks,
    ogDescription: trackLabel,
    ogType: 'music.playlist',
  };
}
