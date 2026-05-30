import type { LidarrArtist, LidarrQualityProfile, LidarrRootFolder } from '../types.js';
import type { LidarrClient } from '../client.js';

export class ArtistApi {
  constructor(private client: LidarrClient) {}

  async lookup(term: string): Promise<LidarrArtist[]> {
    return this.client.request<LidarrArtist[]>(
      `/api/v1/artist/lookup?term=${encodeURIComponent(term)}`,
    );
  }

  async list(): Promise<LidarrArtist[]> {
    return this.client.request<LidarrArtist[]>('/api/v1/artist');
  }

  async get(id: number): Promise<LidarrArtist> {
    return this.client.request<LidarrArtist>(`/api/v1/artist/${id}`);
  }

  /**
   * Adds an artist to Lidarr. Pass the full artist object obtained from
   * `lookup()` — Lidarr's POST body requires the complete looked-up payload
   * (foreignArtistId, images, etc.), so re-fetching here would be wasteful and
   * fragile.
   */
  async add(
    artist: LidarrArtist,
    qualityProfileId: number,
    rootFolderPath: string,
  ): Promise<LidarrArtist> {
    return this.client.request<LidarrArtist>('/api/v1/artist', {
      method: 'POST',
      body: JSON.stringify({
        ...artist,
        qualityProfileId,
        rootFolderPath,
        monitored: true,
        addOptions: { monitor: 'all', searchForMissingAlbums: false },
      }),
    });
  }

  async getQualityProfiles(): Promise<LidarrQualityProfile[]> {
    return this.client.request<LidarrQualityProfile[]>('/api/v1/qualityprofile');
  }

  async getRootFolders(): Promise<LidarrRootFolder[]> {
    return this.client.request<LidarrRootFolder[]>('/api/v1/rootfolder');
  }

  async addRootFolder(path: string): Promise<LidarrRootFolder> {
    return this.client.request<LidarrRootFolder>('/api/v1/rootfolder', {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  }
}
