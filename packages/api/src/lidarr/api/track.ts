import type { LidarrTrack } from '../types.js';
import type { LidarrClient } from '../client.js';

export class TrackApi {
  constructor(private client: LidarrClient) {}

  async listByAlbum(albumId: number): Promise<LidarrTrack[]> {
    return this.client.request<LidarrTrack[]>(`/api/v1/track?albumId=${albumId}`);
  }
}
