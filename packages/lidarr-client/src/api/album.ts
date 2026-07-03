import type { LidarrAlbum } from '../types.js';
import type { LidarrClient } from '../client.js';

export class AlbumApi {
  constructor(private client: LidarrClient) {}

  async listByArtist(artistId: number): Promise<LidarrAlbum[]> {
    return this.client.request<LidarrAlbum[]>(
      `/api/v1/album?artistId=${artistId}&includeAllArtistAlbums=false`,
    );
  }

  async get(id: number): Promise<LidarrAlbum> {
    return this.client.request<LidarrAlbum>(`/api/v1/album/${id}`);
  }

  async lookup(term: string): Promise<LidarrAlbum[]> {
    return this.client.request<LidarrAlbum[]>(
      `/api/v1/album/lookup?term=${encodeURIComponent(term)}`,
    );
  }

  /**
   * Monitored albums Lidarr wants but doesn't have on disk — the "wishlist" the
   * auto-acquisition loop sweeps. `includeArtist=true` so each record carries its
   * `artist.artistName` (needed to build the hunt query); Lidarr paginates, so we
   * return one page's `records`. See docs/auto-acquisition-plan.md.
   */
  async wantedMissing(page = 1, pageSize = 20): Promise<LidarrAlbum[]> {
    const res = await this.client.request<{ records: LidarrAlbum[] }>(
      `/api/v1/wanted/missing?page=${page}&pageSize=${pageSize}` +
        `&sortKey=releaseDate&sortDirection=descending&monitored=true&includeArtist=true`,
    );
    return res.records ?? [];
  }
}
