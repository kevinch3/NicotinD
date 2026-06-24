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
  ogType: 'music.album' | 'music.playlist';
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
