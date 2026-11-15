import type { LidarrTrack } from '../types.js';
import type { LidarrClient } from '../client.js';

export class TrackApi {
  constructor(private client: LidarrClient) {}

  /** The tracks of the album's *monitored* release — often a box set (#1936). */
  async listByAlbum(albumId: number): Promise<LidarrTrack[]> {
    return this.client.request<LidarrTrack[]>(`/api/v1/track?albumId=${albumId}`);
  }

  /** The tracks of one release, monitored or not. */
  async listByRelease(releaseId: number): Promise<LidarrTrack[]> {
    return this.client.request<LidarrTrack[]>(`/api/v1/track?albumReleaseId=${releaseId}`);
  }
}
