import { LidarrClient, type LidarrClientOptions } from './client.js';
import { ArtistApi } from './api/artist.js';
import { AlbumApi } from './api/album.js';
import { TrackApi } from './api/track.js';

export class Lidarr {
  private client: LidarrClient;

  public artist: ArtistApi;
  public album: AlbumApi;
  public track: TrackApi;

  constructor(options: LidarrClientOptions) {
    this.client = new LidarrClient(options);
    this.artist = new ArtistApi(this.client);
    this.album = new AlbumApi(this.client);
    this.track = new TrackApi(this.client);
  }

  ping(): Promise<boolean> {
    return this.client.ping();
  }
}

export { LidarrClient } from './client.js';
export type { LidarrClientOptions } from './client.js';
export type {
  LidarrArtist,
  LidarrAlbum,
  LidarrAlbumRelease,
  LidarrTrack,
  LidarrImage,
  LidarrQualityProfile,
  LidarrRootFolder,
} from './types.js';
