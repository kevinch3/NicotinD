import type {
  LidarrArtist,
  LidarrMetadataProfile,
  LidarrQualityProfile,
  LidarrRootFolder,
} from '../types.js';
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
    metadataProfileId: number,
  ): Promise<LidarrArtist> {
    return this.client.request<LidarrArtist>('/api/v1/artist', {
      method: 'POST',
      body: JSON.stringify({
        ...artist,
        qualityProfileId,
        metadataProfileId,
        rootFolderPath,
        monitored: true,
        addOptions: { monitor: 'all', searchForMissingAlbums: false },
      }),
    });
  }

  async getQualityProfiles(): Promise<LidarrQualityProfile[]> {
    return this.client.request<LidarrQualityProfile[]>('/api/v1/qualityprofile');
  }

  async getMetadataProfiles(): Promise<LidarrMetadataProfile[]> {
    return this.client.request<LidarrMetadataProfile[]>('/api/v1/metadataprofile');
  }

  async getRootFolders(): Promise<LidarrRootFolder[]> {
    return this.client.request<LidarrRootFolder[]>('/api/v1/rootfolder');
  }

  /**
   * Lidarr's POST /api/v1/rootfolder requires a complete payload with default
   * profile IDs and monitor options, not just `path`. We fetch the default
   * profiles here and submit them so the call succeeds on a fresh Lidarr.
   */
  async addRootFolder(path: string, name = 'Music'): Promise<LidarrRootFolder> {
    const [qualityProfiles, metadataProfiles] = await Promise.all([
      this.getQualityProfiles(),
      this.getMetadataProfiles(),
    ]);
    if (!qualityProfiles.length) throw new Error('Lidarr has no quality profiles available');
    if (!metadataProfiles.length) throw new Error('Lidarr has no metadata profiles available');

    return this.client.request<LidarrRootFolder>('/api/v1/rootfolder', {
      method: 'POST',
      body: JSON.stringify({
        name,
        path,
        defaultQualityProfileId: qualityProfiles[0].id,
        defaultMetadataProfileId: metadataProfiles[0].id,
        defaultMonitorOption: 'all',
        defaultNewItemMonitorOption: 'all',
        defaultTags: [],
      }),
    });
  }
}
