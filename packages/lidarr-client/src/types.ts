export interface LidarrArtist {
  id: number;
  foreignArtistId: string; // MusicBrainz artist ID
  artistName: string;
  sortName: string;
  status: string;
  overview?: string;
  images: LidarrImage[];
  albumCount?: number;
  monitored: boolean;
  qualityProfileId?: number;
  rootFolderPath?: string;
  path?: string;
}

export interface LidarrAlbum {
  id: number;
  foreignAlbumId: string; // MusicBrainz release-group ID
  title: string;
  releaseDate?: string;
  albumType: string; // "Album", "Single", "EP", "Broadcast", "Other"
  secondaryTypes?: string[];
  statistics?: {
    trackCount: number;
    totalTrackCount: number;
    sizeOnDisk: number;
    percentOfTracks: number;
  };
  monitored: boolean;
  images?: LidarrImage[];
  artist?: LidarrArtist;
  releases?: LidarrAlbumRelease[];
}

export interface LidarrAlbumRelease {
  id: number;
  foreignReleaseId: string;
  title: string;
  status: string;
  duration: number;
  trackCount: number;
  media: Array<{ mediumNumber: number; name: string; format: string }>;
  country: string[];
  label: string[];
  disambiguation: string;
  format: string;
  monitored: boolean;
}

export interface LidarrTrack {
  id: number;
  foreignTrackId: string;
  foreignRecordingId: string;
  trackFileId: number;
  albumId: number;
  artistId: number;
  trackNumber: string;
  absoluteTrackNumber: number;
  title: string;
  duration: number; // ms
  hasFile: boolean;
}

export interface LidarrImage {
  url: string;
  coverType: string;
  remoteUrl?: string;
}

export interface LidarrQualityProfile {
  id: number;
  name: string;
}

export interface LidarrRootFolder {
  id: number;
  path: string;
  freeSpace: number;
}
