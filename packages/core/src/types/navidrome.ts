export interface SubsonicResponse<T = unknown> {
  'subsonic-response': {
    status: 'ok' | 'failed';
    version: string;
    type: string;
    serverVersion: string;
    openSubsonic: boolean;
    error?: SubsonicError;
  } & T;
}

export interface SubsonicError {
  code: number;
  message: string;
}

export interface Artist {
  id: string;
  name: string;
  albumCount: number;
  coverArt?: string;
  starred?: string;
}

export interface ArtistCredit {
  id: string;
  name: string;
  role: 'primary' | 'featuring';
}

export interface Album {
  id: string;
  name: string;
  artist: string;
  artistId: string;
  artists?: ArtistCredit[];
  coverArt?: string;
  songCount: number;
  duration: number;
  year?: number;
  genre?: string;
  created: string;
  starred?: string;
}

export interface Song {
  id: string;
  title: string;
  album: string;
  albumId: string;
  artist: string;
  artistId: string;
  artists?: ArtistCredit[];
  albumArtist?: string;
  albumArtistId?: string;
  track?: number;
  year?: number;
  genre?: string;
  coverArt?: string;
  size: number;
  contentType: string;
  suffix: string;
  duration: number;
  bitRate: number;
  path: string;
  created: string;
  starred?: string;
  /** Beats per minute, from tags or on-demand analysis. Absent when unknown. */
  bpm?: number;
  /** Musical key, e.g. "C major" / "A minor". Absent when unknown. */
  key?: string;
}

export interface SearchResult3 {
  artist: Artist[];
  album: Album[];
  song: Song[];
}

export interface ScanStatus {
  scanning: boolean;
  count: number;
}

export interface Playlist {
  id: string;
  name: string;
  songCount: number;
  duration: number;
  owner: string;
  public: boolean;
  created: string;
  changed: string;
  coverArt?: string;
  entry?: Song[];
}
