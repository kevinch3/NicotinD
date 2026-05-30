import type { LidarrAlbum } from '../types.js';
import type { LidarrClient } from '../client.js';

export class AlbumApi {
  constructor(private client: LidarrClient) {}

  async listByArtist(artistId: number): Promise<LidarrAlbum[]> {
    return this.client.request<LidarrAlbum[]>(`/api/v1/album?artistId=${artistId}&includeAllArtistAlbums=false`);
  }

  async get(id: number): Promise<LidarrAlbum> {
    return this.client.request<LidarrAlbum>(`/api/v1/album/${id}`);
  }

  async lookup(term: string): Promise<LidarrAlbum[]> {
    return this.client.request<LidarrAlbum[]>(
      `/api/v1/album/lookup?term=${encodeURIComponent(term)}`,
    );
  }
}
